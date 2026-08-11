#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import sharp from "sharp";

const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const configPath = path.join(projectRoot, "art-source/cutout-config.json");
const reportPath = path.join(projectRoot, "art-source/cutout-report.json");
const qaRoot = path.join(projectRoot, "output/cutout-qa");

const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));

async function sha256(filePath) {
  const contents = await fs.readFile(filePath);
  return crypto.createHash("sha256").update(contents).digest("hex");
}

function srgbChannelToLinear(value) {
  const normalized = value / 255;
  return normalized <= 0.04045
    ? normalized / 12.92
    : ((normalized + 0.055) / 1.055) ** 2.4;
}

function rgbToOklab(red, green, blue) {
  const r = srgbChannelToLinear(red);
  const g = srgbChannelToLinear(green);
  const b = srgbChannelToLinear(blue);
  const l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
  const m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
  const s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;
  const lRoot = Math.cbrt(l);
  const mRoot = Math.cbrt(m);
  const sRoot = Math.cbrt(s);
  return [
    0.2104542553 * lRoot + 0.793617785 * mRoot - 0.0040720468 * sRoot,
    1.9779984951 * lRoot - 2.428592205 * mRoot + 0.4505937099 * sRoot,
    0.0259040371 * lRoot + 0.7827717662 * mRoot - 0.808675766 * sRoot,
  ];
}

function labDistance(labL, labA, labB, first, second) {
  const deltaL = labL[first] - labL[second];
  const deltaA = labA[first] - labA[second];
  const deltaB = labB[first] - labB[second];
  return Math.sqrt(deltaL * deltaL + deltaA * deltaA + deltaB * deltaB);
}

function modelDistance(labL, labA, labB, modelL, modelA, modelB, index) {
  const deltaL = labL[index] - modelL[index];
  const deltaA = labA[index] - modelA[index];
  const deltaB = labB[index] - modelB[index];
  return Math.sqrt(deltaL * deltaL + deltaA * deltaA + deltaB * deltaB);
}

function pixelOffset(index, channels) {
  return index * channels;
}

function averageEdgePixel(data, channels, width, height, coordinates) {
  let red = 0;
  let green = 0;
  let blue = 0;
  for (const [x, y] of coordinates) {
    const offset = pixelOffset(y * width + x, channels);
    red += data[offset];
    green += data[offset + 1];
    blue += data[offset + 2];
  }
  const count = coordinates.length;
  return [red / count, green / count, blue / count];
}

function buildBackgroundModel(data, channels, width, height, edgeBand) {
  const left = new Array(height);
  const right = new Array(height);

  for (let y = 0; y < height; y += 1) {
    const leftCoordinates = [];
    const rightCoordinates = [];
    for (let x = 0; x < edgeBand; x += 1) {
      leftCoordinates.push([x, y]);
      rightCoordinates.push([width - 1 - x, y]);
    }
    left[y] = averageEdgePixel(data, channels, width, height, leftCoordinates);
    right[y] = averageEdgePixel(data, channels, width, height, rightCoordinates);
  }

  const pixels = width * height;
  const modelRgb = new Float32Array(pixels * 3);
  const modelL = new Float32Array(pixels);
  const modelA = new Float32Array(pixels);
  const modelB = new Float32Array(pixels);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const horizontalRatio = width === 1 ? 0 : x / (width - 1);
      const horizontal = [0, 1, 2].map(
        (channel) => left[y][channel] * (1 - horizontalRatio) + right[y][channel] * horizontalRatio,
      );
      // Canonical character art reaches the bottom edge. Treating that edge as
      // background would teach the model that skirts, trousers, or hair are
      // background and leave vertical bands behind the cutout. The side bands
      // remain clear, while slow gradients are followed by flood-fill steps.
      const red = horizontal[0];
      const green = horizontal[1];
      const blue = horizontal[2];
      const index = y * width + x;
      const modelOffset = index * 3;
      modelRgb[modelOffset] = red;
      modelRgb[modelOffset + 1] = green;
      modelRgb[modelOffset + 2] = blue;
      const [l, a, b] = rgbToOklab(red, green, blue);
      modelL[index] = l;
      modelA[index] = a;
      modelB[index] = b;
    }
  }

  return { modelRgb, modelL, modelA, modelB };
}

function buildImageLab(data, channels, pixels) {
  const labL = new Float32Array(pixels);
  const labA = new Float32Array(pixels);
  const labB = new Float32Array(pixels);
  for (let index = 0; index < pixels; index += 1) {
    const offset = pixelOffset(index, channels);
    const [l, a, b] = rgbToOklab(data[offset], data[offset + 1], data[offset + 2]);
    labL[index] = l;
    labA[index] = a;
    labB[index] = b;
  }
  return { labL, labA, labB };
}

function createBackgroundMask(width, height, labs, model, options) {
  const pixels = width * height;
  const background = new Uint8Array(pixels);
  const queued = new Uint8Array(pixels);
  const queue = new Int32Array(pixels);
  let queueStart = 0;
  let queueEnd = 0;

  const enqueueSeed = (index) => {
    if (queued[index]) return;
    const distance = modelDistance(
      labs.labL,
      labs.labA,
      labs.labB,
      model.modelL,
      model.modelA,
      model.modelB,
      index,
    );
    if (distance > options.seedTolerance) return;
    queued[index] = 1;
    background[index] = 1;
    queue[queueEnd] = index;
    queueEnd += 1;
  };

  for (let x = 0; x < width; x += 1) enqueueSeed(x);
  for (let y = 0; y < height; y += 1) {
    enqueueSeed(y * width);
    enqueueSeed(y * width + width - 1);
  }
  const bottomCornerWidth = Math.max(1, Math.floor(width * 0.12));
  for (let x = 0; x < bottomCornerWidth; x += 1) {
    enqueueSeed((height - 1) * width + x);
    enqueueSeed((height - 1) * width + width - 1 - x);
  }
  for (const seed of options.backgroundSeeds ?? []) {
    enqueueSeed(clamp(Math.round(seed.y), 0, height - 1) * width + clamp(Math.round(seed.x), 0, width - 1));
  }

  const maybeEnqueue = (current, next) => {
    if (queued[next]) return;
    const expectedDistance = modelDistance(
      labs.labL,
      labs.labA,
      labs.labB,
      model.modelL,
      model.modelA,
      model.modelB,
      next,
    );
    const localDistance = labDistance(labs.labL, labs.labA, labs.labB, current, next);
    const accepted =
      expectedDistance <= options.modelTolerance ||
      (localDistance <= options.stepTolerance && expectedDistance <= options.driftTolerance);
    if (!accepted) return;
    queued[next] = 1;
    background[next] = 1;
    queue[queueEnd] = next;
    queueEnd += 1;
  };

  while (queueStart < queueEnd) {
    const current = queue[queueStart];
    queueStart += 1;
    const x = current % width;
    const y = Math.floor(current / width);
    if (x > 0) maybeEnqueue(current, current - 1);
    if (x + 1 < width) maybeEnqueue(current, current + 1);
    if (y > 0) maybeEnqueue(current, current - width);
    if (y + 1 < height) maybeEnqueue(current, current + width);
  }

  return background;
}

function hasOppositeNeighbor(mask, width, height, index) {
  const x = index % width;
  const y = Math.floor(index / width);
  const value = mask[index];
  for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
    for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
      if (offsetX === 0 && offsetY === 0) continue;
      const nextX = x + offsetX;
      const nextY = y + offsetY;
      if (nextX < 0 || nextX >= width || nextY < 0 || nextY >= height) continue;
      if (mask[nextY * width + nextX] !== value) return true;
    }
  }
  return false;
}

function smoothstep(value) {
  const normalized = clamp(value, 0, 1);
  return normalized * normalized * (3 - 2 * normalized);
}

function createAlphaMask(background, width, height, labs, model, options) {
  const alpha = new Uint8Array(width * height);
  for (let index = 0; index < alpha.length; index += 1) {
    alpha[index] = background[index] ? 0 : 255;
  }
  for (let index = 0; index < alpha.length; index += 1) {
    if (!hasOppositeNeighbor(background, width, height, index)) continue;
    const distance = modelDistance(
      labs.labL,
      labs.labA,
      labs.labB,
      model.modelL,
      model.modelA,
      model.modelB,
      index,
    );
    const ratio = (distance - options.featherLow) / (options.featherHigh - options.featherLow);
    alpha[index] = Math.round(smoothstep(ratio) * 255);
  }
  return alpha;
}

function buildOutputs(sourceData, channels, alpha, model) {
  const pixels = alpha.length;
  const preserveRgb = Buffer.alloc(pixels * 4);
  const runtime = Buffer.alloc(pixels * 4);
  for (let index = 0; index < pixels; index += 1) {
    const sourceOffset = pixelOffset(index, channels);
    const outputOffset = index * 4;
    const alphaByte = alpha[index];
    const alphaRatio = alphaByte / 255;
    for (let channel = 0; channel < 3; channel += 1) {
      const sourceValue = sourceData[sourceOffset + channel];
      preserveRgb[outputOffset + channel] = sourceValue;
      if (alphaByte === 0) {
        runtime[outputOffset + channel] = 0;
      } else if (alphaByte === 255) {
        runtime[outputOffset + channel] = sourceValue;
      } else {
        const backgroundValue = model.modelRgb[index * 3 + channel];
        const unmixed = (sourceValue - (1 - alphaRatio) * backgroundValue) / Math.max(alphaRatio, 0.08);
        runtime[outputOffset + channel] = Math.round(clamp(unmixed, 0, 255));
      }
    }
    preserveRgb[outputOffset + 3] = alphaByte;
    runtime[outputOffset + 3] = alphaByte;
  }
  return { preserveRgb, runtime };
}

function alphaStatistics(alpha, width, height) {
  let transparent = 0;
  let partial = 0;
  let opaque = 0;
  let minimumX = width;
  let minimumY = height;
  let maximumX = -1;
  let maximumY = -1;
  for (let index = 0; index < alpha.length; index += 1) {
    const value = alpha[index];
    if (value === 0) transparent += 1;
    else if (value === 255) opaque += 1;
    else partial += 1;
    if (value > 0) {
      const x = index % width;
      const y = Math.floor(index / width);
      minimumX = Math.min(minimumX, x);
      minimumY = Math.min(minimumY, y);
      maximumX = Math.max(maximumX, x);
      maximumY = Math.max(maximumY, y);
    }
  }
  return {
    transparentPixels: transparent,
    partiallyTransparentPixels: partial,
    opaquePixels: opaque,
    foregroundRatio: (opaque + partial) / alpha.length,
    foregroundBounds: maximumX < 0 ? null : {
      x: minimumX,
      y: minimumY,
      width: maximumX - minimumX + 1,
      height: maximumY - minimumY + 1,
    },
  };
}

async function writeRgba(filePath, data, width, height) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await sharp(data, { raw: { width, height, channels: 4 } })
    .png({ compressionLevel: 9, adaptiveFiltering: true })
    .toFile(filePath);
}

async function writeMask(filePath, alpha, width, height) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await sharp(Buffer.from(alpha), { raw: { width, height, channels: 1 } })
    .png({ compressionLevel: 9, adaptiveFiltering: true })
    .toFile(filePath);
}

async function checkerboard(width, height) {
  const data = Buffer.alloc(width * height * 3);
  const cellSize = 32;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const light = (Math.floor(x / cellSize) + Math.floor(y / cellSize)) % 2 === 0;
      const value = light ? 232 : 188;
      const offset = (y * width + x) * 3;
      data[offset] = value;
      data[offset + 1] = value;
      data[offset + 2] = value;
    }
  }
  return sharp(data, { raw: { width, height, channels: 3 } }).png().toBuffer();
}

async function makeQaSheet(asset, sourcePath, runtimePath, width, height) {
  const tileWidth = Math.round(width / 2);
  const tileHeight = Math.round(height / 2);
  const runtime = await fs.readFile(runtimePath);
  const checker = await checkerboard(width, height);
  const backgrounds = [
    { label: "ORIGINAL", source: await fs.readFile(sourcePath) },
    { label: "CHECKER", background: checker },
    { label: "WHITE", color: "#ffffff" },
    { label: "BLACK", color: "#111111" },
    { label: "MAGENTA", color: "#ff00ff" },
    { label: "GREEN", color: "#00b85a" },
  ];
  const tiles = [];
  for (const background of backgrounds) {
    let composite;
    if (background.source) {
      composite = background.source;
    } else {
      const base = background.background
        ? sharp(background.background)
        : sharp({ create: { width, height, channels: 3, background: background.color } });
      composite = await base.composite([{ input: runtime }]).png().toBuffer();
    }
    const label = Buffer.from(
      `<svg width="${tileWidth}" height="38"><rect width="100%" height="100%" fill="rgba(0,0,0,.68)"/><text x="18" y="26" fill="white" font-size="20" font-family="sans-serif">${background.label}</text></svg>`,
    );
    const tile = await sharp(composite)
      .resize(tileWidth, tileHeight, { fit: "fill" })
      .composite([{ input: label, top: 0, left: 0 }])
      .png()
      .toBuffer();
    tiles.push(tile);
  }
  const sheetPath = path.join(qaRoot, `${asset.id}.png`);
  await fs.mkdir(path.dirname(sheetPath), { recursive: true });
  await sharp({
    create: {
      width: tileWidth * 3,
      height: tileHeight * 2,
      channels: 3,
      background: "#222222",
    },
  })
    .composite(tiles.map((input, index) => ({
      input,
      left: (index % 3) * tileWidth,
      top: Math.floor(index / 3) * tileHeight,
    })))
    .png({ compressionLevel: 9 })
    .toFile(sheetPath);
  return path.relative(projectRoot, sheetPath);
}

async function loadConfiguration() {
  const raw = JSON.parse(await fs.readFile(configPath, "utf8"));
  return {
    ...raw,
    assets: raw.assets.map((asset) => ({ ...raw.defaults, ...asset })),
  };
}

async function generateAsset(asset) {
  const sourcePath = path.join(projectRoot, asset.source);
  const preservePath = path.join(projectRoot, asset.preserveRgbOutput);
  const runtimePath = path.join(projectRoot, asset.runtimeOutput);
  const maskPath = path.join(projectRoot, asset.maskOutput);
  const beforeHash = await sha256(sourcePath);
  if (beforeHash !== asset.expectedSha256) {
    throw new Error(`${asset.id}: source hash changed; refusing to process ${asset.source}`);
  }

  const { data, info } = await sharp(sourcePath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  const pixels = width * height;
  const labs = buildImageLab(data, channels, pixels);
  const model = buildBackgroundModel(data, channels, width, height, asset.edgeBand);
  const background = createBackgroundMask(width, height, labs, model, asset);
  const alpha = createAlphaMask(background, width, height, labs, model, asset);
  const outputs = buildOutputs(data, channels, alpha, model);

  await writeRgba(preservePath, outputs.preserveRgb, width, height);
  await writeRgba(runtimePath, outputs.runtime, width, height);
  await writeMask(maskPath, alpha, width, height);
  const qaSheet = await makeQaSheet(asset, sourcePath, runtimePath, width, height);
  const afterHash = await sha256(sourcePath);
  if (afterHash !== beforeHash) throw new Error(`${asset.id}: original source changed during processing`);

  return {
    id: asset.id,
    kind: asset.kind,
    source: asset.source,
    sourceSha256: beforeHash,
    sourceUnchanged: true,
    width,
    height,
    preserveRgbOutput: asset.preserveRgbOutput,
    runtimeOutput: asset.runtimeOutput,
    maskOutput: asset.maskOutput,
    qaSheet,
    preservePaperOutline: Boolean(asset.preservePaperOutline),
    ...alphaStatistics(alpha, width, height),
  };
}

async function generate() {
  const configuration = await loadConfiguration();
  const results = [];
  for (const asset of configuration.assets) {
    process.stdout.write(`cutout: ${asset.id}\n`);
    results.push(await generateAsset(asset));
  }
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    generator: "tools/image_cutout.mjs",
    config: path.relative(projectRoot, configPath),
    originalsPolicy: "immutable-byte-for-byte",
    assets: results,
  };
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`wrote ${path.relative(projectRoot, reportPath)}\n`);
}

async function verify() {
  const configuration = await loadConfiguration();
  const report = JSON.parse(await fs.readFile(reportPath, "utf8"));
  const reportById = new Map(report.assets.map((asset) => [asset.id, asset]));
  const failures = [];
  for (const asset of configuration.assets) {
    const sourcePath = path.join(projectRoot, asset.source);
    const currentHash = await sha256(sourcePath);
    if (currentHash !== asset.expectedSha256) failures.push(`${asset.id}: original hash mismatch`);
    const recorded = reportById.get(asset.id);
    if (!recorded) failures.push(`${asset.id}: missing report entry`);
    let sourceImage;
    try {
      sourceImage = await sharp(sourcePath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    } catch (error) {
      failures.push(`${asset.id}: cannot read source pixels (${error.message})`);
      continue;
    }
    const decodedOutputs = {};
    for (const outputKey of ["preserveRgbOutput", "runtimeOutput", "maskOutput"]) {
      const outputPath = path.join(projectRoot, asset[outputKey]);
      try {
        const metadata = await sharp(outputPath).metadata();
        if (metadata.width !== recorded?.width || metadata.height !== recorded?.height) {
          failures.push(`${asset.id}: ${outputKey} dimensions changed`);
        }
        if (outputKey !== "maskOutput" && !metadata.hasAlpha) {
          failures.push(`${asset.id}: ${outputKey} has no alpha channel`);
        }
        decodedOutputs[outputKey] = await sharp(outputPath).raw().toBuffer({ resolveWithObject: true });
      } catch (error) {
        failures.push(`${asset.id}: missing ${outputKey} (${error.message})`);
      }
    }
    if (!recorded?.transparentPixels) failures.push(`${asset.id}: no transparent pixels generated`);
    if (!recorded?.foregroundBounds) failures.push(`${asset.id}: no foreground detected`);

    const preserve = decodedOutputs.preserveRgbOutput;
    const runtime = decodedOutputs.runtimeOutput;
    const mask = decodedOutputs.maskOutput;
    if (preserve && runtime && mask) {
      const pixels = sourceImage.info.width * sourceImage.info.height;
      for (let index = 0; index < pixels; index += 1) {
        const sourceOffset = index * sourceImage.info.channels;
        const preserveOffset = index * preserve.info.channels;
        const runtimeOffset = index * runtime.info.channels;
        const maskOffset = index * mask.info.channels;
        const maskAlpha = mask.data[maskOffset];
        if (preserve.data[preserveOffset + 3] !== maskAlpha || runtime.data[runtimeOffset + 3] !== maskAlpha) {
          failures.push(`${asset.id}: alpha mask diverges from derived images at pixel ${index}`);
          break;
        }
        for (let channel = 0; channel < 3; channel += 1) {
          if (preserve.data[preserveOffset + channel] !== sourceImage.data[sourceOffset + channel]) {
            failures.push(`${asset.id}: preserve-RGB output changed source RGB at pixel ${index}`);
            index = pixels;
            break;
          }
          if (maskAlpha === 255 && runtime.data[runtimeOffset + channel] !== sourceImage.data[sourceOffset + channel]) {
            failures.push(`${asset.id}: runtime output changed an opaque foreground pixel at ${index}`);
            index = pixels;
            break;
          }
        }
      }
      for (const probe of asset.paperOutlineProbes ?? []) {
        const x = clamp(Math.round(probe.x), 0, sourceImage.info.width - 1);
        const y = clamp(Math.round(probe.y), 0, sourceImage.info.height - 1);
        const index = y * sourceImage.info.width + x;
        const alphaValue = runtime.data[index * runtime.info.channels + 3];
        if (alphaValue < 250) {
          failures.push(`${asset.id}: paper outline probe ${x},${y} was removed (alpha ${alphaValue})`);
        }
      }
    }
  }
  if (failures.length) {
    throw new Error(`cutout verification failed:\n- ${failures.join("\n- ")}`);
  }
  process.stdout.write(`verified ${configuration.assets.length} immutable originals and cutout sets\n`);
}

const command = process.argv[2] ?? "generate";
if (command === "generate") await generate();
else if (command === "verify") await verify();
else throw new Error(`unknown command: ${command}`);
