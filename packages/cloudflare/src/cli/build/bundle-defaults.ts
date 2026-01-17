/**
 * Default bundle configuration for OpenNext Cloudflare adapter.
 *
 * These defaults can be overridden or extended via open-next.config.ts:
 *
 * ```ts
 * export default defineCloudflareConfig({
 *   bundle: {
 *     external: ["my-native-module"],
 *     stubEmpty: ["my-heavy-package"],
 *     includeDefaults: true, // merge with these defaults
 *   }
 * });
 * ```
 */

/**
 * Default optional dependencies that get special handling.
 * When installed, they're bundled; when missing, they throw at runtime.
 */
export const DEFAULT_OPTIONAL_DEPENDENCIES = [
	"caniuse-lite",
	"critters",
	"jimp",
	"probe-image-size",
	// `server.edge` is not available in react-dom@18
	"react-dom/server.edge",
	// styled-jsx is used by pages router, not needed for app-router-only apps
	"styled-jsx",
];

/**
 * Default packages to mark as truly external (not bundled at all).
 * These are Node.js-only packages that cannot run on Workers.
 */
export const DEFAULT_EXTERNAL = [
	"./middleware/handler.mjs",
	"@tensorflow/tfjs-node",
];

/**
 * Default packages to stub with empty module exports.
 * These are imported at module level but often not actually used at runtime.
 */
export const DEFAULT_STUB_EMPTY = [
	// Dev/test packages that should never be in production bundle
	"typescript",
	"jsdom",
	"coffee-script",
	"eslint",
	"prettier",
	"jest",

	// Heavy server-side packages
	"googleapis",
	"@google-cloud/speech",
	"@google-cloud/text-to-speech",
	"@google-cloud/storage",
	"@google-cloud/translate",
	"@google-cloud/bigquery",
	"@google-cloud/firestore",
	"@google-cloud/common",
	"google-gax",
	"@grpc/grpc-js",
	"@grpc/proto-loader",
	"twilio",
	"puppeteer",
	"puppeteer-core",
	"sharp",
	"ioredis",
	"hume",
	"openai",
	"@mediapipe/tasks-vision",

	// Firebase Admin (server-side only)
	"firebase-admin",
	"firebase-admin/app",
	"firebase-admin/auth",
	"firebase-admin/firestore",
	"firebase-admin/storage",
	"firebase-admin/messaging",
	"firebase-admin/database",

	// MCP SDK
	"@modelcontextprotocol/sdk",

	// Polyfills not needed in Workers (has native support)
	"web-streams-polyfill",
	"web-streams-polyfill/dist/ponyfill.es2018.js",

	// Heavy dependencies that can be stubbed
	"iconv-lite",
	"vm2",
	"acorn",
	"critters",
	"source-map",
	"source-map-js",

	// Edge runtime (not supported)
	"next/dist/compiled/edge-runtime",

	// WebSockets (Workers have builtin)
	"next/dist/compiled/ws",
];

/**
 * Default packages to stub with throwing implementation.
 * These will throw if actually called at runtime.
 */
export const DEFAULT_STUB_THROW = [
	// The toolbox optimizer pulls several MB of dependencies
	"next/dist/compiled/@ampproject/toolbox-optimizer",
];

/**
 * Default packages to replace with fetch shim.
 * These are fetch polyfills not needed in Workers.
 */
export const DEFAULT_STUB_FETCH = [
	"next/dist/compiled/node-fetch",
	"node-fetch",
];

/**
 * Default packages to replace with env shim.
 * OpenNext inlines env values at build time.
 */
export const DEFAULT_STUB_ENV = [
	"@next/env",
];

/**
 * Packages that need styled-jsx shim (pages router support).
 */
export const DEFAULT_STUB_STYLED_JSX = [
	"styled-jsx",
];
