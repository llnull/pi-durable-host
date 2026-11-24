// 用户图片入会话前的整理（pi-durable 1.6 images/fit）。
//
// 此前 /api/ask 的图片附件原样 base64 入库：体积不受控、可能超出模型限制、坏图会在之后的每次请求里反复失败。
// 现在提交前先按"会话当前模型"的限制解码 / 缩放 / 转码：每张图都会被真正解码（provider 会拒绝的坏图、超大图
// 不再进 transcript），并给模型留下"改了什么"的说明；说明同时回给 UI。
import { imageLimits } from "@earendil-works/pi-durable/tools";
import { fitImages } from "@earendil-works/pi-durable/images/fit";

/** 模型是否接受图片输入（pi-ai 的 input 模态）。 */
export function modelAcceptsImages(model) {
	return Array.isArray(model?.input) && model.input.includes("image");
}

const modelName = (model) => `${model?.provider ?? "?"}/${model?.modelId ?? model?.id ?? "?"}`;

/** 真正的整理函数：由 host 注入处理器（Photon，images 特性开启时才有）。 */
export function makeFitter(processor) {
	if (!processor) return undefined;
	return (content, model) => fitImages(content, imageLimits(model), processor);
}

/**
 * 把一条带图片的消息整理成最终交给 submit 的 UserInput。
 * fit：makeFitter(processor)；没有处理器时原样透传（只补"模型不支持图片"的提醒）。
 * placeholder：用户只发了图没打字时，文本块用的占位（默认"（见图片）"）。
 * 返回 { content, notes, images }：images = 整理后仍保留的图片数。
 * 所有图片都被剔除且用户原本没有输入文字时抛错——不让一条只剩占位的消息去浪费一次模型调用。
 */
export async function fitUserImages({ text, images, model, fit, placeholder = "（见图片）" }) {
	// "有没有文字"看用户原始输入；占位只是给模型看的
	const hasText = Boolean(String(text ?? "").trim());
	const content = [{ type: "text", text: hasText ? text : placeholder }, ...images.map((im) => ({ type: "image", data: im.data, mimeType: im.mimeType }))];
	const notes = [];
	if (!modelAcceptsImages(model)) notes.push(`当前模型 ${modelName(model)} 不支持图片输入：图片会留在会话记录里，但不进入模型上下文`);
	if (!fit) return { content, notes, images: images.length };
	const fitted = await fit(content, model);
	if (fitted.kind !== "fitted") return { content, notes, images: images.length };
	const kept = fitted.content.filter((b) => b.type === "image").length;
	if (kept === 0 && !hasText) throw new Error(`图片都无法处理，已全部剔除：${fitted.notes.join("；") || "（解码失败）"}`);
	return { content: fitted.content, notes: [...fitted.notes, ...notes], images: kept };
}
