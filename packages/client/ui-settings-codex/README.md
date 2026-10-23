---
description: "The Codex subagent provider's settings page on the dsh web client's Plugins page: its socket path, TCP endpoint, and permissions."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-settings-codex

English | [中文](README.zh.md)

## Summary

Open **Plugins** in the sidebar and select **Codex Subagent** in the Official group to set the provider's Unix domain socket path, TCP host, TCP port, permission mode, and model override. The page stages edits and writes them only on save. The page exists while the Host serves the `subagent-codex` namespace.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)

-----

<a id="use-this-package"></a>
## Use this package

The **Codex Subagent** card in the Official group opens the page. **Unix Domain Socket Path** sets the path to the codex daemon socket (default `/tmp/codex-engine.sock`). **TCP Host** and **TCP Port** configure network socket connections when not using a Unix domain socket. **Permission Mode** selects non-interactive execution permissions (`never`, `approve-for-me`, or `dangerously-bypass-approvals-and-sandbox`). **Model Override** allows passing a specific model to the Codex daemon.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The Host half is an empty `apply`, present only so the package holds a Loader row the client module system serves the browser half for. The browser half binds the `subagent-codex` namespace through `ctx.configForms.get` and keeps the staged form in `CodexCardController` over the shared `SettingsFormModel` of `ui-primitives`. The page registers `CodexCard` into the Plugins page's `plugins.item` slot through `ctx.configForms.whileServed`.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [ui-plugin-manager](../ui-plugin-manager/README.md) — the Plugins page and the `plugins.item` slot the page registers into.
- [ui-settings](../ui-settings/README.md) — the settings scope and the served-namespace watch the page rides.
- [subagent-codex](../../subagent/subagent-codex/README.md) — the provider that registers the namespace.

-----

<a id="model-experience"></a>
## Model Experience

None, as the package is a browser-side settings surface that registers no model surface.
