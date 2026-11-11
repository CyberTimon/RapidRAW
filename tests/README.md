# Tests

Automated tests for RapidRAW. They live here, outside the app source, so test code never ships in
the app.

## Run

```bash
npm test                 # all tests
npm test -- cache_utils  # only tests whose name contains "cache_utils"
```

The first run builds the app, so it needs the same setup as `npm start` and takes a few minutes.
Plain `cargo test` skips these tests: they build only with the `test-api` feature, which `npm test`
enables. CI runs them on every pull request and push to main.

## Add a test

1. Put tests for `src-tauri/src/<name>.rs` in `tests/rust/<name>.rs`. For a new file, add a
   `mod <name>;` line to `tests/rust/main.rs` and start the file with a short comment on what
   breaks for users when its tests fail.
2. Use the app through `rapidraw_lib`. Many types are already public there through `pub use` in
   `src-tauri/src/lib.rs`. For a `pub` item of a private module, change the module's line in
   `lib.rs` from `mod name;` to `test_api_mod!(name);`, which makes it public only for the tests.
   To test the app as users run it, for example the command-line export, run the binary with
   `Command::new(env!("CARGO_BIN_EXE_RapidRAW"))`.
3. Run `npm test` and make sure the new test can fail: break the code it covers, see the test go
   red, then undo the break. Then run `cargo fmt` in `src-tauri`, which CI checks for tests too.

## Rules

- Generate inputs (images, settings, adjustments) in the test. The repository holds no test
  images.
- Assert relations and tolerances (equal, changed, within 1/255) rather than exact values that
  change between Rust or library versions, such as `DefaultHasher` hashes.
- A test that needs a GPU or a display returns early, with a printed reason, on machines without
  one.
