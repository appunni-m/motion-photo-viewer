# Releasing

A release is a tag. Pushing one runs the same gate as `main`, rebuilds the
WebAssembly module from the tagged source, and publishes a GitHub release with
that module attached.

```sh
# 1. Everything must be green and committed.
make verify && make verify-browser

# 2. Bump the version in one place, commit, push.
$EDITOR crates/motion-photo-wasm/Cargo.toml   # version = "0.2.0"
git commit -am "Release 0.2.0"
git push

# 3. Tag it and push the tag. The workflow does the rest.
git tag -a v0.2.0 -m "Motion Photo Viewer 0.2.0"
git push origin v0.2.0
```

`.github/workflows/release.yml` then:

1. runs `cargo fmt --check`, clippy with warnings denied, the Rust unit tests,
   the deterministic suite (56 checks), the real-camera checks, the artifact
   validation and the headless browser run;
2. fails if the tag does not match the crate version;
3. attaches `motion_photo_wasm.wasm` and its `BUILD.txt` digest to the release,
   and generates the notes from the commits, prefixed by
   [`.github/release-notes.md`](release-notes.md).

`workflow_dispatch` runs the same verification against an existing tag without
publishing anything, which is the way to re-check a release after the fact.

The app itself is deployed on every push to `main` by
[`pages.yml`](workflows/pages.yml), independently of releases, so the live site
always tracks `main` and a tag only decides what is archived.
