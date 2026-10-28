function normalizedFrame(source: CanvasImageSource, width: number, height: number): string {
  if (!width || !height) throw new Error('화면이 아직 준비되지 않았습니다. 잠시 후 다시 촬영해주세요.');
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1024;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('이 브라우저에서 사진을 처리할 수 없습니다. 다른 브라우저에서 다시 시도해주세요.');
  context.fillStyle = '#f4f4f4'; context.fillRect(0, 0, 1024, 1024);
  const scale = Math.min(1024 / width, 1024 / height);
  const w = width * scale, h = height * scale;
  context.drawImage(source, (1024 - w) / 2, (1024 - h) / 2, w, h);
  try {
    let result = canvas.toDataURL('image/png');
    while (result.length > 3_800_000 && canvas.width > 256) {
      const reduced = document.createElement('canvas');
      reduced.width = reduced.height = Math.floor(canvas.width * 0.8);
      reduced.getContext('2d')!.drawImage(canvas, 0, 0, reduced.width, reduced.height);
      canvas.width = reduced.width;
      canvas.height = reduced.height;
      canvas.getContext('2d')!.drawImage(reduced, 0, 0);
      result = canvas.toDataURL('image/png');
    }
    if (result.length > 3_800_000) throw new Error('사진 용량이 너무 큽니다. 더 작은 사진을 선택해주세요.');
    return result;
  } catch (e) {
    if (e instanceof DOMException) throw new Error('참고 사진을 읽을 수 없습니다. 사진 파일로 다시 등록해주세요.');
    throw e;
  }
}

export function captureVideoPhoto(video: HTMLVideoElement): string {
  if (video.readyState < 2) throw new Error('카메라 화면을 불러오는 중입니다. 잠시 후 다시 촬영해주세요.');
  // CSS mirroring is for the selfie preview only; save the original orientation.
  return normalizedFrame(video, video.videoWidth, video.videoHeight);
}

export async function normalizePhoto(src: string): Promise<string> {
  const image = new Image();
  if (!src.startsWith('data:') && !src.startsWith('blob:')) image.crossOrigin = 'anonymous';
  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error('사진을 읽을 수 없습니다. PNG·JPEG·WebP 사진으로 다시 선택해주세요.'));
    image.src = src;
  });
  return normalizedFrame(image, image.naturalWidth, image.naturalHeight);
}

export async function photoFromFile(file: File): Promise<string> {
  const supported = ['image/png','image/jpeg','image/jpg','image/webp'].includes(file.type)
    || (!file.type && /\.(png|jpe?g|webp)$/i.test(file.name));
  if (!supported || file.size > 15_000_000) throw new Error('15MB 이하 PNG·JPEG·WebP 사진을 선택해주세요.');
  const url = URL.createObjectURL(file);
  try { return await normalizePhoto(url); } finally { URL.revokeObjectURL(url); }
}
