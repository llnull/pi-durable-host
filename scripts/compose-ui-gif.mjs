// GIF 剪辑合成 v2：按真实时间戳与阶段采样——动作段全帧率、流式长尾抽稀、时长真实。
// 用法：node scripts/compose-ui-gif.mjs <帧目录（含 meta.json）> [输出路径]
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const src = process.argv[2];
const outAbs = resolve(process.argv[3] ?? "docs/ui-demo.gif");
if (!src) { console.error("用法: node compose-ui-gif.mjs <帧目录> [输出]"); process.exit(1); }
const meta = JSON.parse(readFileSync(join(src, "meta.json"), "utf8"));
const files = readdirSync(src).filter((f) => f.endsWith(".png")).sort();
if (files.length !== meta.frames.length) throw new Error(`帧数不符: ${files.length} vs ${meta.frames.length}`);

// 1. 帧序列：{f, at(ms), phase, size, hash}
const seq = meta.frames.map((m) => {
	const p = join(src, m.f);
	return { ...m, p, size: statSync(p).size, hash: null, dt: 0 };
});
for (let i = 0; i < seq.length; i++) seq[i].hash = createHash("md5").update(readFileSync(seq[i].p)).digest("hex");
console.log("原始帧:", seq.length);

// 2. 内容去重（连续相同画面合并，dt 累加）
const uniq = [];
for (const f of seq) {
	if (f.size === 0) continue;
	const last = uniq[uniq.length - 1];
	if (last && last.hash === f.hash) { last.dt += f.at - last.atEnd; last.atEnd = f.at; continue; }
	f.atEnd = f.at;
	f.dt = last ? f.at - last.atEnd : 100;
	uniq.push(f);
}
console.log("内容去重后:", uniq.length);

// 3. 分段采样（时间预算制）：各段目标片长（秒），段内均匀抽帧补齐到 10fps。
//    这样片长 = 预算之和，不依赖录屏真实帧率，也不被 ffmpeg concat 时间基坑。
const BUDGET = { load: 1.2, typing: 3.2, stream: 8, act: 2.8 };
const kept = [];
for (const ph of Object.keys(BUDGET)) {
	const seg = uniq.filter((f) => f.phase === ph);
	if (!seg.length) continue;
	const target = Math.round(BUDGET[ph] * 10); // 10fps 下的帧数
	const step = Math.max(1, seg.length / target);
	for (let i = 0; i < seg.length && kept.filter((k) => k.phase === ph).length < target; i += step) {
		kept.push(seg[Math.floor(i)]);
	}
}
const totalMs = kept.length * 100;
console.log(`采样后: ${kept.length} 帧，片长 = ${(totalMs / 1000).toFixed(1)}s`);

// 4. 固定 10fps 展开（kept 即逐帧序列）→ palettegen/paletteuse 合成
const fdir = "/tmp/gif-final";
if (existsSync(fdir)) rmSync(fdir, { recursive: true });
mkdirSync(fdir, { recursive: true });
kept.forEach((f, i) => writeFileSync(join(fdir, `d${String(i).padStart(5, "0")}.png`), readFileSync(f.p)));
execSync(`ffmpeg -y -loglevel error -framerate 10 -i ${fdir}/d%05d.png -vf "scale=1000:-1:flags=lanczos,palettegen=max_colors=256" /tmp/pal.png`);
execSync(`ffmpeg -y -loglevel error -framerate 10 -i ${fdir}/d%05d.png -i /tmp/pal.png -lavfi "scale=1000:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=sierra2_4a:diff_mode=rectangle" ${JSON.stringify(outAbs)}`);
const dur = Number(execSync(`ffprobe -v error -show_entries format=duration -of csv=p=0 ${JSON.stringify(outAbs)}`).toString().trim());
const kb = (statSync(outAbs).size / 1024).toFixed(0);
console.log(`GIF: ${outAbs} — ${dur.toFixed(1)}s / ${kb}KB / ${kept.length} 帧`);
