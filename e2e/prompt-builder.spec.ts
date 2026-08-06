import { expect, test } from "@playwright/test";

test("prompt builder separates verified tags from prose and exposes reproducible tools", async ({ page }) => {
  await page.goto("/prompts");

  await expect(page.getByRole("heading", { name: "캐릭터 프롬프트 빌더" })).toBeVisible();
  await expect(page.getByLabel("NovelAI 권장 설정")).toContainText("NovelAI Diffusion V4.5 Full");
  await expect(page.getByLabel("NovelAI 권장 설정")).toContainText("Quality Tags ON");
  await expect(page.getByLabel("NovelAI 권장 설정")).toContainText("Variety · OFF");
  await expect(page.getByLabel("프롬프트 출처 검사 결과")).toContainText("출처 검사 통과");

  const extraTags = page.getByLabel("추가 검증 태그 선택");
  await extraTags.fill("unknown beauty magic");
  const unknownTagAlert = page.locator(".prompt-field-error").filter({ hasText: "미등록 태그" });
  await expect(unknownTagAlert).toContainText("미등록 태그: unknown beauty magic");
  await expect(unknownTagAlert).toContainText("자연어 지시로 옮기세요");

  await extraTags.fill("holding, book");
  await page.getByLabel("태그로 표현 못 하는 세부 지시 선택").fill(
    "Keep the book close to her chest while preserving her face",
  );
  const combinedPrompt = page.getByRole("textbox", { name: "① Prompt", exact: true });
  await expect(combinedPrompt).toHaveValue(/holding.*book/);
  await expect(combinedPrompt).toHaveValue(
    /Keep the book close to her chest while preserving her face\./,
  );

  await page.getByRole("radio", { name: /차민경/ }).check();
  await expect(page.getByRole("img", { name: "차민경 메인 로비 원화" })).toBeVisible();
  await expect(page.getByRole("img", { name: "차민경 점 위치 보강 원화" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "기존 눈물점 옆 두 번째 점 추가", exact: true })).toHaveValue(/beside the existing under-eye mark/);
  await expect(page.getByRole("textbox", { name: "왼쪽 아래 목 점", exact: true })).toHaveValue(/left side of her lower neck/);
  await expect(page.getByRole("textbox", { name: "쇄골 아래 중앙 점", exact: true })).toHaveValue(/below the collarbones and above the cleavage/);

  await page.getByRole("radio", { name: /강유진/ }).check();
  await expect(combinedPrompt).toHaveValue(/pink eyes/);
  await expect(combinedPrompt).toHaveValue(/vivid clear rose-pink irises/);
  await expect(combinedPrompt).not.toHaveValue(/aqua eyes|black eyes/);
  await expect(page.getByRole("textbox", { name: "② UC 추가 태그", exact: true })).toHaveValue(/aqua eyes, black eyes/);

  await page.getByRole("radio", { name: /공통 · 분노/ }).check();
  await expect(combinedPrompt).toHaveValue(/angry, scowl, furrowed brow, v-shaped eyebrows, open mouth/);
  await expect(combinedPrompt).toHaveValue(/pink eyes/);

  await page.getByRole("radio", { name: /공통 · 공포에 빠져 울기/ }).check();
  await expect(combinedPrompt).toHaveValue(/scared, crying, crying with eyes open, tears, wide-eyed/);
  await expect(combinedPrompt).toHaveValue(/Keep all established face, hair, body, outfit, accessory, prop, and rendering details unchanged/);
  await expect(combinedPrompt).toHaveValue(/pink eyes/);

  await extraTags.fill("");
  await page.getByLabel("태그로 표현 못 하는 세부 지시 선택").fill("");
  await page.getByRole("radio", { name: /공통 · 데포르메 SD 종이 얼굴/ }).check();
  await expect(combinedPrompt).toHaveValue(/chibi, head only, papercraft \(medium\), paper texture, outline, white outline/);
  await expect(combinedPrompt).toHaveValue(/smile, closed mouth/);
  await expect(combinedPrompt).toHaveValue(/pink eyes/);
  await expect(combinedPrompt).toHaveValue(/long upturned rose-pink eyes/);
  await expect(combinedPrompt).toHaveValue(/narrow tapered oval face/);
  await expect(combinedPrompt).toHaveValue(/1\.2::high ponytail::/);
  await expect(combinedPrompt).toHaveValue(/1\.25::pink eyes::/);
  await expect(combinedPrompt).toHaveValue(/long upturned rose-pink eyes/);
  await expect(combinedPrompt).toHaveValue(/narrow tapered oval face/);
  await expect(combinedPrompt).not.toHaveValue(/smooth cheeks/);
  await expect(combinedPrompt).toHaveValue(/high ponytail and curved side locks/);
  await expect(page.getByRole("textbox", { name: "② UC 추가 태그", exact: true })).toHaveValue(/blush, blush stickers/);
  await expect(combinedPrompt).toHaveValue(/gentle closed-mouth smile/);
  await expect(combinedPrompt).toHaveValue(/Use a cute super-deformed face/);
  await expect(combinedPrompt).toHaveValue(/continuous unprinted white margin/);
  await expect(combinedPrompt).toHaveValue(/cut with scissors along its outside edge/);
  await expect(combinedPrompt).not.toHaveValue(/visual novel|white shirt|grey pants|medium breasts/);
  await expect(page.getByRole("textbox", { name: "② UC 추가 태그", exact: true })).toHaveValue(/neck, upper body, full body, cowboy shot, wide-eyed, open mouth, pout, serious, raised eyebrow/);

  await page.locator('input[name="prompt-character"][value="yoon_seo_a"]').check();
  await page.getByRole("radio", { name: /공통 · 데포르메 SD 종이 얼굴/ }).check();
  await expect(combinedPrompt).toHaveValue(/1\.4::a white paper outline around the entire hair silhouette::/);

  await page.locator('input[name="prompt-character"][value="cha_min_kyung"]').check();
  await page.getByRole("radio", { name: /공통 · 데포르메 SD 종이 얼굴/ }).check();
  await expect(combinedPrompt).toHaveValue(/1\.35::floating head::/);
  await expect(combinedPrompt).toHaveValue(/Cut 1\.6::at the chin, background directly below, no neck::/);

  await page.getByText("선택 도구 · UC 추가 / 동일 시드 A/B 비교").click();
  await page.getByLabel(/동일 시드 A\/B 비교/).check();
  await page.getByLabel("NovelAI Seed").fill("123456");
  await page.getByLabel("B에서만 추가할 검증 태그").fill("smile");
  await expect(page.getByText(/NovelAI Seed에 123456/)).toBeVisible();
  await expect(page.getByRole("textbox", { name: "B Prompt", exact: true })).toHaveValue(/smile/);
});
