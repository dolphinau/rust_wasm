{pkgs, ...}: {
  packages = [
    pkgs.nil
    pkgs.nixd
    pkgs.alejandra
    pkgs.just
    pkgs.cargo-component
    pkgs.wasmtime
  ];

  languages = {
    javascript = {
      enable = true;
      npm.enable = true;
    };
    rust = {
      channel = "nightly";
      components = [
        "cargo"
        "rust-src"
        "rustc"
        "rust-analyzer"
        "clippy"
      ];
      targets = [
        "wasm32-wasip1"
        "wasm32-wasip2"
      ];
      enable = true;
    };
  };
}
