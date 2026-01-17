import { execSync } from "node:child_process";
import fs from "node:fs";
import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { type BuildOptions, getPackagePath } from "@opennextjs/aws/build/helper.js";
import { ContentUpdater } from "@opennextjs/aws/plugins/content-updater.js";
import { build, type Plugin } from "esbuild";

import { getOpenNextConfig, type BundleConfig } from "../../api/config.js";
import type { ProjectOptions } from "../project-options.js";
import {
	DEFAULT_OPTIONAL_DEPENDENCIES,
	DEFAULT_EXTERNAL,
	DEFAULT_STUB_EMPTY,
	DEFAULT_STUB_THROW,
	DEFAULT_STUB_FETCH,
	DEFAULT_STUB_ENV,
	DEFAULT_STUB_STYLED_JSX,
} from "./bundle-defaults.js";
import { patchVercelOgLibrary } from "./patches/ast/patch-vercel-og-library.js";
import { patchWebpackRuntime } from "./patches/ast/webpack-runtime.js";
import { inlineDynamicRequires } from "./patches/plugins/dynamic-requires.js";
import { inlineFindDir } from "./patches/plugins/find-dir.js";
import { patchInstrumentation } from "./patches/plugins/instrumentation.js";
import { inlineLoadManifest } from "./patches/plugins/load-manifest.js";
import { patchNextServer } from "./patches/plugins/next-server.js";
import { patchResolveCache, patchSetWorkingDirectory } from "./patches/plugins/open-next.js";
import { handleOptionalDependencies } from "./patches/plugins/optional-deps.js";
import { patchPagesRouterContext } from "./patches/plugins/pages-router-context.js";
import { patchDepdDeprecations } from "./patches/plugins/patch-depd-deprecations.js";
import { fixRequire } from "./patches/plugins/require.js";
import { shimRequireHook } from "./patches/plugins/require-hook.js";
import { patchRouteModules } from "./patches/plugins/route-module.js";
import { setWranglerExternal } from "./patches/plugins/wrangler-external.js";
import { copyPackageCliFiles, needsExperimentalReact, normalizePath } from "./utils/index.js";

/** The dist directory of the Cloudflare adapter package */
const packageDistDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * Build the external array from user config and defaults.
 */
function buildExternalArray(bundleConfig: BundleConfig | undefined): string[] {
	const includeDefaults = bundleConfig?.includeDefaults !== false;
	const userExternal = bundleConfig?.external ?? [];

	if (includeDefaults) {
		return [...DEFAULT_EXTERNAL, ...userExternal];
	}
	return userExternal;
}

/**
 * Build the alias map from user config and defaults.
 */
function buildAliasMap(bundleConfig: BundleConfig | undefined, outputDir: string): Record<string, string> {
	const includeDefaults = bundleConfig?.includeDefaults !== false;
	const emptyShim = path.join(outputDir, "cloudflare-templates/shims/empty.js");
	const throwShim = path.join(outputDir, "cloudflare-templates/shims/throw.js");
	const fetchShim = path.join(outputDir, "cloudflare-templates/shims/fetch.js");
	const envShim = path.join(outputDir, "cloudflare-templates/shims/env.js");

	const alias: Record<string, string> = {};

	if (includeDefaults) {
		// Add default stub empty packages
		for (const pkg of DEFAULT_STUB_EMPTY) {
			alias[pkg] = emptyShim;
		}

		// Add default stub throw packages
		for (const pkg of DEFAULT_STUB_THROW) {
			alias[pkg] = throwShim;
		}

		// Add default stub fetch packages
		for (const pkg of DEFAULT_STUB_FETCH) {
			alias[pkg] = fetchShim;
		}

		// Add default stub env packages
		for (const pkg of DEFAULT_STUB_ENV) {
			alias[pkg] = envShim;
		}

		// Add default styled-jsx shim
		for (const pkg of DEFAULT_STUB_STYLED_JSX) {
			alias[pkg] = emptyShim;
		}
	}

	// Add user stub empty packages
	for (const pkg of bundleConfig?.stubEmpty ?? []) {
		alias[pkg] = emptyShim;
	}

	// Add user stub throw packages
	for (const pkg of bundleConfig?.stubThrow ?? []) {
		alias[pkg] = throwShim;
	}

	// Add user stub fetch packages
	for (const pkg of bundleConfig?.stubFetch ?? []) {
		alias[pkg] = fetchShim;
	}

	// Add user stub env packages
	for (const pkg of bundleConfig?.stubEnv ?? []) {
		alias[pkg] = envShim;
	}

	// Add user custom aliases (these take precedence)
	if (bundleConfig?.customAliases) {
		for (const [pkg, shimPath] of Object.entries(bundleConfig.customAliases)) {
			alias[pkg] = shimPath;
		}
	}

	return alias;
}

/**
 * Bundle the Open Next server.
 */
export async function bundleServer(buildOpts: BuildOptions, projectOpts: ProjectOptions): Promise<void> {
	copyPackageCliFiles(packageDistDir, buildOpts);

	const { appPath, outputDir, monorepoRoot, debug } = buildOpts;
	const dotNextPath = path.join(outputDir, "server-functions/default", getPackagePath(buildOpts), ".next");
	const serverFiles = path.join(dotNextPath, "required-server-files.json");
	const nextConfig = JSON.parse(fs.readFileSync(serverFiles, "utf-8")).config;

	const useTurbopack = fs.existsSync(path.join(dotNextPath, "server/chunks/[turbopack]_runtime.js"));

	console.log(`\x1b[35m⚙️ Bundling the OpenNext server...\n\x1b[0m`);

	await patchWebpackRuntime(buildOpts);
	patchVercelOgLibrary(buildOpts);

	const outputPath = path.join(outputDir, "server-functions", "default");
	const packagePath = getPackagePath(buildOpts);
	const openNextServer = path.join(outputPath, packagePath, `index.mjs`);
	const openNextServerBundle = path.join(outputPath, packagePath, `handler.mjs`);

	const updater = new ContentUpdater(buildOpts);

	// Get bundle configuration from user config (if provided)
	const openNextConfig = getOpenNextConfig(buildOpts);
	const bundleConfig = openNextConfig.cloudflare?.bundle;

	// Build configurable external and alias arrays
	const externalArray = buildExternalArray(bundleConfig);
	const aliasMap = buildAliasMap(bundleConfig, outputDir);

	const result = await build({
		entryPoints: [openNextServer],
		bundle: true,
		outfile: openNextServerBundle,
		format: "esm",
		target: "esnext",
		// Minify code as much as possible but stay safe by not renaming identifiers
		minifyWhitespace: projectOpts.minify && !debug,
		minifyIdentifiers: false,
		minifySyntax: projectOpts.minify && !debug,
		legalComments: "none",
		metafile: true,
		// Next traces files using the default conditions from `nft` (`node`, `require`, `import` and `default`)
		//
		// Because we use the `node` platform for this build, the "module" condition is used when no conditions are defined.
		// The conditions are always set (should it be to an empty array) to disable the "module" condition.
		//
		// See:
		// - default nft conditions: https://github.com/vercel/nft/blob/2b55b01/readme.md#exports--imports
		// - Next no explicit override: https://github.com/vercel/next.js/blob/2efcf11/packages/next/src/build/collect-build-traces.ts#L287
		// - ESBuild `node` platform: https://esbuild.github.io/api/#platform
		conditions: openNextConfig.cloudflare?.useWorkerdCondition === false ? [] : ["workerd"],
		plugins: [
			shimRequireHook(buildOpts),
			inlineDynamicRequires(updater, buildOpts),
			setWranglerExternal(),
			fixRequire(updater),
			handleOptionalDependencies(DEFAULT_OPTIONAL_DEPENDENCIES),
			patchInstrumentation(updater, buildOpts),
			patchPagesRouterContext(buildOpts),
			inlineFindDir(updater, buildOpts),
			inlineLoadManifest(updater, buildOpts),
			patchNextServer(updater, buildOpts),
			patchRouteModules(updater, buildOpts),
			patchDepdDeprecations(updater),
			patchResolveCache(updater, buildOpts),
			patchSetWorkingDirectory(updater, buildOpts),
			// Apply updater updates, must be the last plugin
			updater.plugin,
		] as Plugin[],
		external: externalArray,
		alias: aliasMap,
		define: {
			// config file used by Next.js, see: https://github.com/vercel/next.js/blob/68a7128/packages/next/src/build/utils.ts#L2137-L2139
			"process.env.__NEXT_PRIVATE_STANDALONE_CONFIG": JSON.stringify(JSON.stringify(nextConfig)),
			// Next.js tried to access __dirname so we need to define it
			__dirname: '""',
			// Note: we need the __non_webpack_require__ variable declared as it is used by next-server:
			// https://github.com/vercel/next.js/blob/be0c3283/packages/next/src/server/next-server.ts#L116-L119
			__non_webpack_require__: "require",
			// The 2 following defines are used to reduce the bundle size by removing unnecessary code
			// Next uses different precompiled renderers (i.e. `app-page.runtime.prod.js`) based on if you use `TURBOPACK` or some experimental React features
			...(useTurbopack ? {} : { "process.env.TURBOPACK": "false" }),
			// We make sure that environment variables that Next.js expects are properly defined
			"process.env.NEXT_RUNTIME": '"nodejs"',
			"process.env.NODE_ENV": '"production"',
			// This define should be safe to use for Next 14.2+, earlier versions (13.5 and less) will cause trouble
			"process.env.__NEXT_EXPERIMENTAL_REACT": `${needsExperimentalReact(nextConfig)}`,
			// Fix `res.validate` in Next 15.4 (together with the `route-module` patch)
			"process.env.__NEXT_TRUST_HOST_HEADER": "true",
		},
		banner: {
			// We need to import them here, assigning them to `globalThis` does not work because node:timers use `globalThis` and thus create an infinite loop
			// See https://github.com/cloudflare/workerd/blob/d6a764c/src/node/internal/internal_timers.ts#L56-L70
			js: `import {setInterval, clearInterval, setTimeout, clearTimeout} from "node:timers"`,
		},
		platform: "node",
	});

	fs.writeFileSync(openNextServerBundle + ".meta.json", JSON.stringify(result.metafile, null, 2));

	await updateWorkerBundledCode(openNextServerBundle);

	const isMonorepo = monorepoRoot !== appPath;
	if (isMonorepo) {
		fs.writeFileSync(
			path.join(outputPath, "handler.mjs"),
			`export { handler } from "./${normalizePath(packagePath)}/handler.mjs";`
		);
	}

	console.log(
		`\x1b[35mWorker saved in \`${path.relative(buildOpts.appPath, getOutputWorkerPath(buildOpts))}\` 🚀\n\x1b[0m`
	);
}

/**
 * This function apply updates to the bundled code.
 * For large files (>100MB), uses sed to avoid JavaScript string length limits.
 */
export async function updateWorkerBundledCode(workerOutputFile: string): Promise<void> {
	const MAX_JS_STRING_SIZE = 100 * 1024 * 1024; // 100MB threshold
	const VERY_LARGE_FILE_SIZE = 500 * 1024 * 1024; // 500MB - skip patching entirely
	const fileStats = await stat(workerOutputFile);

	if (fileStats.size > VERY_LARGE_FILE_SIZE) {
		// For extremely large files (>500MB), skip patching entirely
		// The __require patterns are unlikely to cause issues at runtime
		console.log(`Bundle is ${Math.round(fileStats.size / 1024 / 1024)}MB - VERY LARGE. Skipping require patching.`);
		console.warn(`⚠️  Warning: Bundle exceeds 500MB. Consider reducing bundle size.`);
		return;
	}

	if (fileStats.size > MAX_JS_STRING_SIZE) {
		// Use sed for large files to avoid JavaScript string length limits
		console.log(`Bundle is ${Math.round(fileStats.size / 1024 / 1024)}MB, using sed for patching...`);
		try {
			// macOS sed requires -i '' for in-place editing, Linux uses -i
			const isMacOS = process.platform === "darwin";
			// Use separate backup extension for macOS sed compatibility
			const sedCmd = isMacOS
				? `sed -i.bak 's/__require\\([0-9]*\\)(/require(/g' "${workerOutputFile}" && rm "${workerOutputFile}.bak"`
				: `sed -i 's/__require\\([0-9]*\\)(/require(/g' "${workerOutputFile}"`;
			const sedCmd2 = isMacOS
				? `sed -i.bak 's/__require\\([0-9]*\\)\\./require./g' "${workerOutputFile}" && rm "${workerOutputFile}.bak"`
				: `sed -i 's/__require\\([0-9]*\\)\\./require./g' "${workerOutputFile}"`;

			// Run sed replacements
			execSync(sedCmd, { stdio: "pipe" });
			execSync(sedCmd2, { stdio: "pipe" });
		} catch (error) {
			console.warn("sed patching failed, skipping:", error);
			// Don't fallback to Node-based approach for very large files - just skip
			return;
		}
	} else {
		const code = await readFile(workerOutputFile, "utf8");
		const patchedCode = code.replace(/__require\d?\(/g, "require(").replace(/__require\d?\./g, "require.");
		await writeFile(workerOutputFile, patchedCode);
	}
}

/**
 * Gets the path of the worker.js file generated by the build process
 *
 * @param buildOpts the open-next build options
 * @returns the path of the worker.js file that the build process generates
 */
export function getOutputWorkerPath(buildOpts: BuildOptions): string {
	return path.join(buildOpts.outputDir, "worker.js");
}
