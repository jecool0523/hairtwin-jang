import { beforeEach, describe, expect, it, vi } from 'vitest';
import { captureVideoPhoto, normalizePhoto, photoFromFile } from './photos';

describe('photo preparation', () => {
  const photo = 'data:image/png;base64,normalized';
  beforeEach(() => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ fillRect: vi.fn(), drawImage: vi.fn() } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue(photo);
    vi.stubGlobal('Image', class {
      naturalWidth = 1280; naturalHeight = 720;
      onload?: () => void;
      set src(_source: string) { queueMicrotask(() => this.onload?.()); }
    });
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:test-photo') });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
  });

  it('rejects capture before a decodable video frame exists', () => {
    expect(() => captureVideoPhoto({ readyState: 1, videoWidth: 1280, videoHeight: 720 } as HTMLVideoElement)).toThrow('불러오는 중');
    expect(() => captureVideoPhoto({ readyState: 2, videoWidth: 0, videoHeight: 0 } as HTMLVideoElement)).toThrow('아직 준비되지 않았습니다');
  });

  it('reports missing canvas support without silently saving a blank image', async () => {
    vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValue(null);
    await expect(normalizePhoto('data:image/png;base64,input')).rejects.toThrow('사진을 처리할 수 없습니다');
  });

  it('accepts camera files with missing MIME metadata and always releases their object URL', async () => {
    await expect(photoFromFile(new File(['bytes'], 'IMG_1001.JPG', { type: '' }))).resolves.toBe(photo);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:test-photo');
  });

  it('rejects non-image and oversized files before creating any object URL', async () => {
    await expect(photoFromFile(new File(['not an image'], 'note.txt'))).rejects.toThrow('PNG');
    const tooLarge = new File(['bytes'], 'photo.png', { type: 'image/png' });
    Object.defineProperty(tooLarge, 'size', { value: 15_000_001 });
    await expect(photoFromFile(tooLarge)).rejects.toThrow('15MB');
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it('shrinks a large photo before it exceeds the individual upload limit', async () => {
    vi.mocked(HTMLCanvasElement.prototype.toDataURL).mockReturnValueOnce('x'.repeat(3_800_001)).mockReturnValue(photo);
    await expect(normalizePhoto('data:image/png;base64,input')).resolves.toBe(photo);
    expect(HTMLCanvasElement.prototype.toDataURL).toHaveBeenCalledTimes(2);
  });
});
