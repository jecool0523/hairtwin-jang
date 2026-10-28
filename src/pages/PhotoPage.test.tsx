import { act, fireEvent, render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { PhotoPage } from './flow1';
import { useConsult } from '../stores/consultationStore';
import { photoFromFile } from '../utils/photos';

vi.mock('../storage/indexedStorage', () => ({ indexedStorage: {
  getItem: async () => null, setItem: async () => {}, removeItem: async () => {},
} }));
vi.mock('../utils/photos', () => ({
  photoFromFile: vi.fn(), normalizePhoto: vi.fn(),
  captureVideoPhoto: vi.fn(() => 'data:image/png;base64,camera-photo'),
}));

function media() {
  const track = new EventTarget() as EventTarget & { stop: ReturnType<typeof vi.fn>; readyState: string; getSettings: () => object };
  track.stop = vi.fn(() => { track.readyState = 'ended'; }); track.readyState = 'live'; track.getSettings = () => ({ facingMode: 'environment' });
  return { track, stream: { getTracks: () => [track], getVideoTracks: () => [track] } };
}

describe('consultation photos', () => {
  let getUserMedia: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    useConsult.getState().reset();
    getUserMedia = vi.fn();
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia } });
    Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true });
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
  });
  const mount = () => render(<MemoryRouter initialEntries={['/consultations/new/photo']}><PhotoPage /></MemoryRouter>);

  it('separates browser capture from the gallery picker and keeps a native camera fallback', () => {
    const page = mount();
    expect(page.getByRole('button', { name: '카메라로 촬영' })).toBeTruthy();
    expect(page.getByRole('button', { name: '사진 파일 선택' })).toBeTruthy();
    expect(page.getByLabelText('정면 고객 사진').hasAttribute('capture')).toBe(false);
    expect(page.getByLabelText('정면 기기 카메라 사진').getAttribute('capture')).toBe('environment');
    expect((page.getByRole('button', { name: '다음 · 스타일 고르기' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('saves front, side and back separately and only then enables the next step', async () => {
    const page = mount();
    const photos: Record<string, string> = {};
    for (const [label, view] of [['정면', 'front'], ['측면', 'side'], ['후면', 'back']]) {
      const device = media(); getUserMedia.mockResolvedValueOnce(device.stream);
      fireEvent.click(page.getByRole('button', { name: '카메라로 촬영' }));
      const video = page.getByLabelText(label + ' 카메라 미리보기') as HTMLVideoElement;
      await waitFor(() => expect(video.srcObject).toBe(device.stream));
      Object.defineProperties(video, { readyState: { configurable: true, value: 2 },
        videoWidth: { configurable: true, value: 1280 }, videoHeight: { configurable: true, value: 720 } });
      fireEvent.canPlay(video);
      fireEvent.click(page.getByRole('button', { name: '사진 촬영' }));
      expect(page.queryByRole('dialog')).toBeNull();
      expect(device.track.stop).toHaveBeenCalledOnce();
      photos[view] = 'data:image/png;base64,camera-photo';
      expect(useConsult.getState().photos).toMatchObject(photos);
    }
    expect((page.getByRole('button', { name: '다음 · 스타일 고르기' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('does not overwrite the previous photo when shooting is cancelled', async () => {
    useConsult.getState().set({ photos: { front: 'existing-photo', side: null, back: null } });
    const device = media(); getUserMedia.mockResolvedValueOnce(device.stream);
    const page = mount();
    fireEvent.click(page.getByRole('button', { name: '카메라로 촬영' }));
    await waitFor(() => expect(HTMLMediaElement.prototype.play).toHaveBeenCalled());
    fireEvent.click(page.getByRole('button', { name: '카메라 닫기' }));
    expect(useConsult.getState().photos.front).toBe('existing-photo');
    expect(device.track.stop).toHaveBeenCalledOnce();
  });

  it('discards a photo load after leaving the page', async () => {
    let resolve!: (photo: string) => void;
    vi.mocked(photoFromFile).mockReturnValueOnce(new Promise(done => { resolve = done; }));
    const page = mount();
    fireEvent.change(page.getByLabelText('정면 고객 사진'), { target: { files: [new File(['image'], 'photo.jpg', { type: 'image/jpeg' })] } });
    expect((page.getByRole('button', { name: '○ 측면' }) as HTMLButtonElement).disabled).toBe(true);
    page.unmount();
    await act(async () => resolve('late-photo'));
    expect(useConsult.getState().photos).toEqual({ front: null, side: null, back: null });
  });

  it('keeps the original photo direction when the active tab changes while a file picker is open', async () => {
    vi.mocked(photoFromFile).mockResolvedValueOnce('front-upload');
    const page = mount();
    fireEvent.click(page.getByRole('button', { name: '사진 파일 선택' }));
    fireEvent.click(page.getByRole('button', { name: '○ 후면' }));
    fireEvent.change(page.getByLabelText('후면 고객 사진'), { target: { files: [new File(['image'], 'photo.jpg', { type: 'image/jpeg' })] } });
    await waitFor(() => expect(useConsult.getState().photos.front).toBe('front-upload'));
    expect(useConsult.getState().photos.back).toBeNull();
  });

  it('resets the file input after a failed upload so the same file can be retried', async () => {
    vi.mocked(photoFromFile).mockRejectedValueOnce(new Error('잘못된 사진')).mockResolvedValueOnce('valid-photo');
    const page = mount(), input = page.getByLabelText('정면 고객 사진') as HTMLInputElement;
    const file = new File(['image'], 'photo.jpg', { type: 'image/jpeg' });
    fireEvent.change(input, { target: { files: [file] } });
    expect((await page.findByRole('alert')).textContent).toContain('잘못된 사진');
    expect(input.value).toBe('');
    fireEvent.change(input, { target: { files: [file] } });
    await waitFor(() => expect(useConsult.getState().photos.front).toBe('valid-photo'));
    expect(page.queryByRole('alert')).toBeNull();
  });
});
