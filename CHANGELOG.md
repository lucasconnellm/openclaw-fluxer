# Changelog

## [0.4.0](https://github.com/lucasconnellm/openclaw-fluxer/compare/v0.3.0...v0.4.0) (2026-02-20)


### Features

* add environment specification to release job in workflow ([e2d8dc8](https://github.com/lucasconnellm/openclaw-fluxer/commit/e2d8dc8ed9673848ac94b9bdcfeffe13e7287948))
* add extensions field to OpenClaw configuration ([6cd34c0](https://github.com/lucasconnellm/openclaw-fluxer/commit/6cd34c08ca2530eff4289c501abcb273f63ae22e))
* add GitHub Actions workflow for publishing package to npm ([eaf9cd4](https://github.com/lucasconnellm/openclaw-fluxer/commit/eaf9cd42ddcc1ef28b1d96ec0df4b654d7741e90))
* add npm test step to release workflow ([4cb07dc](https://github.com/lucasconnellm/openclaw-fluxer/commit/4cb07dcf387685f9cda538e9d5dde8dda96e5f9a))
* add repository field to package.json ([0181ed0](https://github.com/lucasconnellm/openclaw-fluxer/commit/0181ed02e21dd6e1b9e36b5dea1ac47e728174c4))
* **fluxer:** add outbound react action support ([d136b09](https://github.com/lucasconnellm/openclaw-fluxer/commit/d136b09cc6979ba78ee12f2f28b58d12b60d4afa))
* **fluxer:** experimentally register slash command prefixes on startup ([86d6892](https://github.com/lucasconnellm/openclaw-fluxer/commit/86d6892504da40d58e5397c857ea41fb703acf57))
* **fluxer:** send outbound media as native attachments ([68d0ad2](https://github.com/lucasconnellm/openclaw-fluxer/commit/68d0ad2751d9680d066014bf7dba9f978ea90f53))
* **fluxer:** send typing indicators during reply dispatch ([86a44d0](https://github.com/lucasconnellm/openclaw-fluxer/commit/86a44d0dc2199087410086dd7413b404f8eca6ba))
* remove NODE_AUTH_TOKEN from npm publish step in release workflow ([4294a74](https://github.com/lucasconnellm/openclaw-fluxer/commit/4294a749cd5020b9de59e99796d7abc6c81f0418))
* scaffold fluxer plugin package with @fluxerjs/core integration ([ccd144e](https://github.com/lucasconnellm/openclaw-fluxer/commit/ccd144e464f0819c15e12b7d2e175c606844556d))
* send outbound media as native Fluxer attachments ([a891531](https://github.com/lucasconnellm/openclaw-fluxer/commit/a8915311cfa8e0b2d5f93310abf302177e72301d))
* update installation and configuration instructions in README ([19ef82a](https://github.com/lucasconnellm/openclaw-fluxer/commit/19ef82a11bfb69149498dcb62f4548664f8aa772))
* update Node.js version and npm installation in release workflow ([d1f9a4d](https://github.com/lucasconnellm/openclaw-fluxer/commit/d1f9a4d11a288d31a092814100765cdc25cf699a))


### Bug Fixes

* **fluxer:** reduce websocket flap by classifying monitor errors ([3708ed1](https://github.com/lucasconnellm/openclaw-fluxer/commit/3708ed159dced7dfe300c127649260163349d587))
* **pairing:** classify uncached DMs as direct ([a7ac310](https://github.com/lucasconnellm/openclaw-fluxer/commit/a7ac3104be8667a816241d89345f207131028dff))
* **pairing:** classify uncached DMs as direct ([03ac4af](https://github.com/lucasconnellm/openclaw-fluxer/commit/03ac4aff02f2824233f0ce9506b61308d3e7e206))
* remove provenance flag and NODE_AUTH_TOKEN from npm publish step ([17ee2e0](https://github.com/lucasconnellm/openclaw-fluxer/commit/17ee2e08d91f70703a26a6d22e96b0a02e62272a))
* stabilize fluxer monitor websocket error handling ([8327dbd](https://github.com/lucasconnellm/openclaw-fluxer/commit/8327dbd3dbb53c449f1b08fb7d02e382752d15b5))
* use rest.put body wrapper for slash prefix registration ([6d9f40e](https://github.com/lucasconnellm/openclaw-fluxer/commit/6d9f40ec9eb79023f6db2b503366779d7a3bc3db))

## [0.3.0](https://github.com/lucasconnellm/openclaw-fluxer/compare/fluxer-v0.2.2...fluxer-v0.3.0) (2026-02-20)


### Features

* add environment specification to release job in workflow ([e2d8dc8](https://github.com/lucasconnellm/openclaw-fluxer/commit/e2d8dc8ed9673848ac94b9bdcfeffe13e7287948))
* add extensions field to OpenClaw configuration ([6cd34c0](https://github.com/lucasconnellm/openclaw-fluxer/commit/6cd34c08ca2530eff4289c501abcb273f63ae22e))
* add GitHub Actions workflow for publishing package to npm ([eaf9cd4](https://github.com/lucasconnellm/openclaw-fluxer/commit/eaf9cd42ddcc1ef28b1d96ec0df4b654d7741e90))
* add npm test step to release workflow ([4cb07dc](https://github.com/lucasconnellm/openclaw-fluxer/commit/4cb07dcf387685f9cda538e9d5dde8dda96e5f9a))
* add repository field to package.json ([0181ed0](https://github.com/lucasconnellm/openclaw-fluxer/commit/0181ed02e21dd6e1b9e36b5dea1ac47e728174c4))
* **fluxer:** add outbound react action support ([d136b09](https://github.com/lucasconnellm/openclaw-fluxer/commit/d136b09cc6979ba78ee12f2f28b58d12b60d4afa))
* **fluxer:** experimentally register slash command prefixes on startup ([86d6892](https://github.com/lucasconnellm/openclaw-fluxer/commit/86d6892504da40d58e5397c857ea41fb703acf57))
* **fluxer:** send outbound media as native attachments ([68d0ad2](https://github.com/lucasconnellm/openclaw-fluxer/commit/68d0ad2751d9680d066014bf7dba9f978ea90f53))
* **fluxer:** send typing indicators during reply dispatch ([86a44d0](https://github.com/lucasconnellm/openclaw-fluxer/commit/86a44d0dc2199087410086dd7413b404f8eca6ba))
* remove NODE_AUTH_TOKEN from npm publish step in release workflow ([4294a74](https://github.com/lucasconnellm/openclaw-fluxer/commit/4294a749cd5020b9de59e99796d7abc6c81f0418))
* scaffold fluxer plugin package with @fluxerjs/core integration ([ccd144e](https://github.com/lucasconnellm/openclaw-fluxer/commit/ccd144e464f0819c15e12b7d2e175c606844556d))
* send outbound media as native Fluxer attachments ([a891531](https://github.com/lucasconnellm/openclaw-fluxer/commit/a8915311cfa8e0b2d5f93310abf302177e72301d))
* update installation and configuration instructions in README ([19ef82a](https://github.com/lucasconnellm/openclaw-fluxer/commit/19ef82a11bfb69149498dcb62f4548664f8aa772))
* update Node.js version and npm installation in release workflow ([d1f9a4d](https://github.com/lucasconnellm/openclaw-fluxer/commit/d1f9a4d11a288d31a092814100765cdc25cf699a))


### Bug Fixes

* **fluxer:** reduce websocket flap by classifying monitor errors ([3708ed1](https://github.com/lucasconnellm/openclaw-fluxer/commit/3708ed159dced7dfe300c127649260163349d587))
* **pairing:** classify uncached DMs as direct ([a7ac310](https://github.com/lucasconnellm/openclaw-fluxer/commit/a7ac3104be8667a816241d89345f207131028dff))
* **pairing:** classify uncached DMs as direct ([03ac4af](https://github.com/lucasconnellm/openclaw-fluxer/commit/03ac4aff02f2824233f0ce9506b61308d3e7e206))
* remove provenance flag and NODE_AUTH_TOKEN from npm publish step ([17ee2e0](https://github.com/lucasconnellm/openclaw-fluxer/commit/17ee2e08d91f70703a26a6d22e96b0a02e62272a))
* stabilize fluxer monitor websocket error handling ([8327dbd](https://github.com/lucasconnellm/openclaw-fluxer/commit/8327dbd3dbb53c449f1b08fb7d02e382752d15b5))
* use rest.put body wrapper for slash prefix registration ([6d9f40e](https://github.com/lucasconnellm/openclaw-fluxer/commit/6d9f40ec9eb79023f6db2b503366779d7a3bc3db))
