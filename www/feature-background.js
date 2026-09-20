const BACKGROUND_STORAGE_KEY = 'metronome-background-image-v1';
const MAX_SOURCE_FILE_BYTES = 20 * 1024 * 1024;
const MAX_STORED_DATA_LENGTH = 3 * 1024 * 1024;
const MAX_INITIAL_SIDE = 1600;
const MAX_FALLBACK_SIDE = 1200;

export function loadBackgroundImage(storage = globalThis.localStorage) {
  if (!storage) {
    return null;
  }

  try {
    const value = storage.getItem(BACKGROUND_STORAGE_KEY);
    return typeof value === 'string' && value.startsWith('data:image/') ? value : null;
  } catch (error) {
    return null;
  }
}

export function saveBackgroundImage(dataUrl, storage = globalThis.localStorage) {
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) {
    throw new Error('背景图片数据无效。');
  }

  if (dataUrl.length > MAX_STORED_DATA_LENGTH) {
    throw new Error('图片压缩后仍然过大，请选择尺寸更小的图片。');
  }

  if (storage) {
    try {
      storage.setItem(BACKGROUND_STORAGE_KEY, dataUrl);
    } catch (error) {
      throw new Error('设备存储空间不足，无法保存背景图片。');
    }
  }

  return dataUrl;
}

export function removeBackgroundImage(storage = globalThis.localStorage) {
  if (storage) {
    try {
      storage.removeItem(BACKGROUND_STORAGE_KEY);
    } catch (error) {
      // The caller can still clear the current page background.
    }
  }
}

export function applyBackgroundImage(dataUrl, documentRef = document) {
  const root = documentRef.documentElement;
  const body = documentRef.body;

  if (!root || !body) {
    return;
  }

  if (dataUrl) {
    root.style.setProperty('--custom-background-image', `url("${dataUrl}")`);
    body.classList.add('has-custom-background');
  } else {
    root.style.removeProperty('--custom-background-image');
    body.classList.remove('has-custom-background');
  }
}

export function applyStoredBackground(options = {}) {
  const storage = options.storage || globalThis.localStorage;
  const documentRef = options.documentRef || document;
  const dataUrl = loadBackgroundImage(storage);
  applyBackgroundImage(dataUrl, documentRef);
  return dataUrl;
}

export async function processBackgroundFile(file) {
  if (!file || !String(file.type).startsWith('image/')) {
    throw new Error('请选择有效的图片文件。');
  }

  if (file.size > MAX_SOURCE_FILE_BYTES) {
    throw new Error('图片文件过大，请选择 20MB 以内的图片。');
  }

  const sourceDataUrl = await readFileAsDataUrl(file);
  const image = await loadImage(sourceDataUrl);
  let maxSide = MAX_INITIAL_SIDE;
  let quality = 0.82;
  let result = renderImageDataUrl(image, maxSide, quality);

  if (result.length > MAX_STORED_DATA_LENGTH) {
    maxSide = MAX_FALLBACK_SIDE;
    quality = 0.7;
    result = renderImageDataUrl(image, maxSide, quality);
  }

  if (result.length > MAX_STORED_DATA_LENGTH) {
    throw new Error('图片压缩后仍然过大，请选择尺寸更小的图片。');
  }

  return result;
}

function renderImageDataUrl(image, maxSide, quality) {
  const scale = Math.min(1, maxSide / Math.max(image.naturalWidth, image.naturalHeight));
  const width = Math.max(1, Math.round(image.naturalWidth * scale));
  const height = Math.max(1, Math.round(image.naturalHeight * scale));
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');

  canvas.width = width;
  canvas.height = height;
  context.fillStyle = '#f5f7fa';
  context.fillRect(0, 0, width, height);
  context.drawImage(image, 0, 0, width, height);

  return canvas.toDataURL('image/jpeg', quality);
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('读取图片失败，请重新选择。'));
    reader.readAsDataURL(file);
  });
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('无法解析这张图片。'));
    image.src = src;
  });
}

export { BACKGROUND_STORAGE_KEY };