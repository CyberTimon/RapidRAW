# Homebrew Tap

This directory contains the RapidRAW Cask for an upstream-maintained Homebrew tap.

## Publishing

1. Create the public repository `CyberTimon/homebrew-rapidraw`.
2. Copy `Casks/rapidraw.rb` from this directory into that repository.
3. On each release, update the Cask version and SHA-256 values from the uploaded macOS DMGs.

## Installation

After publishing the tap, users can install RapidRAW with:

```sh
brew tap CyberTimon/rapidraw
brew install --cask rapidraw
```

Until macOS releases are signed and notarized, users may receive a Gatekeeper warning on first launch. The signing and notarization workflow is the long-term solution for official Homebrew Cask inclusion.
