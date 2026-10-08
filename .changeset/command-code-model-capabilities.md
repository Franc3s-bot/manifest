---
'manifest': patch
---

Read Command Code model capabilities from the vendor its ids namespace. The provider publishes no modalities and models.dev has no `commandcode` catalog, so every Command Code model was reported as text-only (no `input_modalities`, no `tools`): `commandcode/moonshotai/Kimi-K3` and `commandcode/gpt-5.6-sol` now inherit Kimi K3's and GPT-5.6's image/video input. Command Code is also priced at zero per token (flat monthly plan), so the vendor identity resolved for capabilities cannot leak a per-token rate onto the connection. Synthetic auto-tier models now let a chain member with unknown metadata abstain in the capability majority vote instead of counting as a silent "no", so one uncatalogued model no longer suppresses a capability every known model supports.
