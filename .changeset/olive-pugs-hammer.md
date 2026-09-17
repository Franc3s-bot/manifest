---
'manifest': patch
---

Name gateway models correctly: OpenCode Go models that the underlying vendor's catalog does not list (e.g. `deepseek-v4.1-flash`) now read their name and capabilities from the gateway's own models.dev catalog instead of falling back to the raw model id, the Requests log resolves gateway ids through the pricing catalogue so it matches the routing page, the model picker hides an OpenCode Go id only when a published one already stands for the same model, and a promotional OpenCode Go quota row is parsed instead of skipped.
