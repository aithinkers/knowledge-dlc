try { await fetch("https://example.invalid"); } catch {}
const child = await import("node:child_process");
try { child.spawn("model-provider"); } catch {}
try { child.execFile("model-provider"); } catch {}
try { child.execFileSync(process.execPath, ["-e", "process.exit(0)"]); } catch {}
try { child.spawnSync(process.execPath, ["-e", "process.exit(0)"]); } catch {}
try { child.execSync("model-provider"); } catch {}
try { child.spawn(process.execPath, ["--permission", "--allow-worker", "-e", "process.exit(0)", `${process.env.KDLC_RELEASE_ROOT}/workers/normalizer/worker.mjs`], { shell: false, cwd: process.env.TMPDIR, env: { KDLC_RESTRICTED_WORKER: "1" }, stdio: ["pipe", "pipe", "pipe"] }); } catch {}
try { await (await import("node:dns/promises")).lookup("localhost"); } catch {}
try { (await import("node:dns")).lookup("localhost", () => {}); } catch {}
try { (await import("node:http")).get("http://127.0.0.1/"); } catch {}
try { (await import("node:dgram")).createSocket("udp4"); } catch {}
try { process.binding("tcp_wrap"); } catch {}
