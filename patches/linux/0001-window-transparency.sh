#!/usr/bin/env bash

yq -iP '.app.windows[0].transparent=false' src-tauri/tauri.conf.json
