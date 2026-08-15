try { await fetch("https://example.invalid"); } catch {}
try { (await import("node:child_process")).spawn("model-provider"); } catch {}
