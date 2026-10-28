/** esbuild's "base64" loader turns imported .wasm files into base64 strings. */
declare module "*.wasm" {
	const base64: string;
	export default base64;
}
