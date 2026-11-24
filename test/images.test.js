// 用户图片入会话前的整理（lib/images.js）：fit 以假函数注入，不依赖 Photon / 模型 / 存储。
import test from "node:test";
import assert from "node:assert/strict";
import { fitUserImages, makeFitter, modelAcceptsImages } from "../lib/images.js";

const VISION = { provider: "p", id: "m-vision", input: ["text", "image"] };
const TEXT_ONLY = { provider: "p", id: "m-text", input: ["text"] };
const IMG = { mimeType: "image/png", data: "AAAA" };
const textBlocks = (content) => content.filter((b) => b.type === "text").map((b) => b.text);

test("modelAcceptsImages：看 input 模态；没有 input 字段视为不支持", () => {
	assert.equal(modelAcceptsImages(VISION), true);
	assert.equal(modelAcceptsImages(TEXT_ONLY), false);
	assert.equal(modelAcceptsImages(undefined), false);
	assert.equal(modelAcceptsImages({ provider: "p", id: "x" }), false);
});

test("没有处理器：原样透传；文本模型补一条提醒", async () => {
	const r = await fitUserImages({ text: "看看这个", images: [IMG], model: TEXT_ONLY, fit: undefined });
	assert.equal(r.images, 1);
	assert.deepEqual(r.content, [{ type: "text", text: "看看这个" }, { type: "image", data: "AAAA", mimeType: "image/png" }]);
	assert.equal(r.notes.length, 1);
	assert.match(r.notes[0], /m-text 不支持图片输入/);
	const ok = await fitUserImages({ text: "看看", images: [IMG], model: VISION, fit: undefined });
	assert.deepEqual(ok.notes, []);
});

test("处理器判定无需改动：unchanged，不带说明", async () => {
	const fit = async () => ({ kind: "unchanged" });
	const r = await fitUserImages({ text: "t", images: [IMG], model: VISION, fit });
	assert.equal(r.images, 1);
	assert.deepEqual(r.notes, []);
});

test("处理器缩放了图片：用整理后的内容，带上给模型的说明；文本模型的提醒排在后面", async () => {
	const fittedContent = [{ type: "text", text: "t" }, { type: "image", data: "BBBB", mimeType: "image/jpeg" }];
	const seen = [];
	const fit = async (content, model) => {
		seen.push(model);
		assert.equal(content.length, 2);
		return { kind: "fitted", content: fittedContent, notes: ["Resized from 3000x3000 to 2000x2000."] };
	};
	const r = await fitUserImages({ text: "t", images: [IMG], model: VISION, fit });
	assert.deepEqual(r.content, fittedContent);
	assert.deepEqual(r.notes, ["Resized from 3000x3000 to 2000x2000."]);
	assert.equal(seen[0], VISION, "按会话当前模型整理");
	const r2 = await fitUserImages({ text: "t", images: [IMG], model: TEXT_ONLY, fit });
	assert.equal(r2.notes.length, 2);
	assert.match(r2.notes[1], /不支持图片输入/);
});

test("图片全部被剔除：没有文字就拒绝提交（不让只剩「（见图片）」的消息去调模型）；有文字则照常提交", async () => {
	const fit = async (content) => ({ kind: "fitted", content: [content[0]], notes: ["Image could not be prepared."] }); // 回显文本块、丢掉图片
	// 只发图没打字：占位文字不算"有文字" → 拒绝
	await assert.rejects(() => fitUserImages({ text: "", images: [IMG, IMG], model: VISION, fit }), /图片都无法处理.*Image could not be prepared/);
	await assert.rejects(() => fitUserImages({ text: "   ", images: [IMG], model: VISION, fit }), /图片都无法处理/);
	// 有文字：图片剔除后照常提交文字
	const r = await fitUserImages({ text: "这是截图，请分析", images: [IMG], model: VISION, fit });
	assert.equal(r.images, 0);
	assert.deepEqual(textBlocks(r.content), ["这是截图，请分析"]);
	// 占位文案：没打字时文本块用占位
	const p = await fitUserImages({ text: "", images: [IMG], model: VISION, fit: async () => ({ kind: "unchanged" }) });
	assert.deepEqual(textBlocks(p.content), ["（见图片）"]);
});

test("makeFitter：没有处理器返回 undefined；有则返回可调用的整理函数", () => {
	assert.equal(makeFitter(undefined), undefined);
	const f = makeFitter({});
	assert.equal(typeof f, "function");
});
