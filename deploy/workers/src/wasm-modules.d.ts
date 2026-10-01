// Wrangler's CompiledWasm rule: importing a .wasm file gives a WebAssembly.Module.
declare module "*.wasm" {
  const module: WebAssembly.Module;
  export default module;
}
