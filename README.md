# Rust project to build with wasm-wasip2

## Build

```bash
cargo build --target wasm-wasip2
```

## Transpile with jco

```bash
jco transpile target/wasm32-wasip2/debug/rust_wasm.wasm -o target/transpiled
```

I then create the file `target/transpiled/package.json` with the following content:

```json
{
  "name": "rust_wasm",
  "version": "1.0.0",
  "type": "module",
  "main": "rust_wasm.js",
  "dependencies": {
    "@bytecodealliance/preview2-shim": "^0.17.4"
  }
}
```

