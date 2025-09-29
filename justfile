build:
    cargo component build --target=wasm32-wasip2

transpile:
    jco transpile target/wasm32-wasip2/debug/rust_wasm.wasm -o target/pkg/ --name rust_wasm --no-nodejs-compat 

pack: build transpile
    cp package.json target/pkg
    tar czf target/rust_wasm.tar.gz target/pkg
