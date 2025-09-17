# Rust project to build with wasm-wasip2

Inspired from https://benw.is/posts/compiling-rust-to-wasi

## Build

```bash
cargo build --target wasm-wasip2
```

## Transpile with jco

```bash
jco transpile target/wasm32-wasip2/debug/rust_wasm.wasm \
    --map 'wasi:cli/*=@bytecodealliance/preview2-shim/cli#*' \
    --map 'wasi:clocks/*=@bytecodealliance/preview2-shim/clocks#*' \
    --map 'wasi:filesystem/*=@bytecodealliance/preview2-shim/filesystem#*' \
    --map 'wasi:http/*=@bytecodealliance/preview2-shim/http#*' \
    --map 'wasi:io/*=@bytecodealliance/preview2-shim/io#*' \
    --map 'wasi:random/*=@bytecodealliance/preview2-shim/random#*' \
    --map 'wasi:sockets/*=@bytecodealliance/preview2-shim/sockets#*' \
    --no-nodejs-compat --base64-cutoff 1000000 -o target/transpiled
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

