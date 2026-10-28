import { act, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StrictMode } from 'react';
import { CameraCapture } from './CameraCapture';

const photo = 'data:image/png;base64,test-photo';
function camera(facingMode = 'environment') {
  class Track extends EventTarget {
    readyState = 'live';
    stop = vi.fn(() => { this.readyState = 'ended'; });
    getSettings = () => ({ facingMode });
  }
  const track = new Track();
  return { track, stream: { getTracks: () => [track], getVideoTracks: () => [track] } as unknown as MediaStream };
}
function deferred() {
  let resolve!: (stream: MediaStream) => void;
  return { promise: new Promise<MediaStream>(done => { resolve = done; }), resolve: (stream: MediaStream) => resolve(stream) };
}
function mount() {
  const callbacks = { onCapture: vi.fn(), onClose: vi.fn(), onChooseFile: vi.fn(), onNativeCapture: vi.fn() };
  return { ...render(<CameraCapture label="정면" {...callbacks} />), ...callbacks };
}
function ready(video: HTMLVideoElement) {
  Object.defineProperties(video, { readyState: { configurable: true, value: 2 },
    videoWidth: { configurable: true, value: 1280 }, videoHeight: { configurable: true, value: 720 } });
  fireEvent.loadedData(video);
}

describe('camera preview and lifecycle', () => {
  afterEach(() => vi.useRealTimers());
  let getUserMedia: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    getUserMedia = vi.fn();
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia } });
    Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true });
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ fillRect: vi.fn(), drawImage: vi.fn() } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue(photo);
  });

  it('requests video only, waits for a real frame, then captures an unmirrored normalized PNG', async () => {
    const device = camera('user');
    getUserMedia.mockResolvedValue(device.stream);
    const page = mount();
    await waitFor(() => expect(HTMLMediaElement.prototype.play).toHaveBeenCalled());
    expect(getUserMedia).toHaveBeenCalledWith({ audio: false, video: {
      facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 1280 },
    } });
    const capture = page.getByRole('button', { name: '사진 촬영' }) as HTMLButtonElement;
    const video = page.getByLabelText('정면 카메라 미리보기') as HTMLVideoElement;
    expect(capture.disabled).toBe(true);
    expect(video.playsInline).toBe(true);
    expect(video.muted).toBe(true);
    expect(video.className).toContain('-scale-x-100');
    ready(video);
    expect(capture.disabled).toBe(false);
    fireEvent.click(capture);
    expect(page.onCapture).toHaveBeenCalledWith(photo);
    const context = video.ownerDocument.createElement('canvas').getContext('2d')!;
    expect(context.drawImage).toHaveBeenCalledWith(video, 0, 224, 1024, 576);
    page.unmount();
    expect(device.track.stop).toHaveBeenCalled();
    expect(video.srcObject).toBeNull();
  });

  it('does not enable capture for an empty or not-yet-decoded video', async () => {
    getUserMedia.mockResolvedValue(camera().stream);
    const page = mount();
    await waitFor(() => expect(HTMLMediaElement.prototype.play).toHaveBeenCalled());
    const video = page.getByLabelText('정면 카메라 미리보기');
    fireEvent.canPlay(video);
    fireEvent.click(page.getByRole('button', { name: '사진 촬영' }));
    expect(page.onCapture).not.toHaveBeenCalled();
    expect((page.getByRole('button', { name: '사진 촬영' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('releases hardware before invoking the native camera picker', async () => {
    const device = camera(); getUserMedia.mockResolvedValueOnce(device.stream);
    const page = mount();
    await waitFor(() => expect(HTMLMediaElement.prototype.play).toHaveBeenCalled());
    page.onNativeCapture.mockImplementation(() => expect(device.track.stop).toHaveBeenCalledOnce());
    fireEvent.click(page.getByRole('button', { name: '기기 카메라 사용' }));
    expect(page.onNativeCapture).toHaveBeenCalledOnce();
    expect((page.getByLabelText('정면 카메라 미리보기') as HTMLVideoElement).srcObject).toBeNull();
    page.unmount();
    expect(device.track.stop).toHaveBeenCalledOnce();
  });

  it.each([
    ['NotAllowedError', '권한이 차단'], ['NotFoundError', '연결된 카메라'], ['NotReadableError', '다른 앱'],
  ])('provides an actionable %s error and a file fallback', async (name, message) => {
    getUserMedia.mockRejectedValue(new DOMException('test only', name));
    const page = mount();
    expect((await page.findByRole('alert')).textContent).toContain(message);
    expect((page.getByRole('button', { name: '사진 촬영' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(page.getByRole('button', { name: '사진 파일 선택' }));
    expect(page.onChooseFile).toHaveBeenCalledOnce();
  });

  it('offers native camera capture when the media API is missing', async () => {
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: undefined });
    const page = mount();
    expect((await page.findByRole('alert')).textContent).toContain('실시간 카메라를 사용할 수 없습니다');
    fireEvent.click(page.getByRole('button', { name: '기기 카메라 사용' }));
    expect(page.onNativeCapture).toHaveBeenCalledOnce();
  });

  it('falls back to unconstrained video only when the requested constraints are unsupported', async () => {
    getUserMedia.mockRejectedValueOnce(new DOMException('test only', 'OverconstrainedError')).mockResolvedValueOnce(camera().stream);
    mount();
    await waitFor(() => expect(HTMLMediaElement.prototype.play).toHaveBeenCalled());
    expect(getUserMedia).toHaveBeenLastCalledWith({ audio: false, video: true });
  });

  it('releases a stream whose permission request resolves after the dialog closes', async () => {
    const pending = deferred(), late = camera();
    getUserMedia.mockReturnValue(pending.promise);
    const page = mount();
    page.unmount();
    await act(async () => pending.resolve(late.stream));
    expect(late.track.stop).toHaveBeenCalledOnce();
    expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
  });

  it('offers a fallback after an unanswered permission request and stops a late stream', async () => {
    vi.useFakeTimers();
    const pending = deferred(), late = camera();
    getUserMedia.mockReturnValueOnce(pending.promise);
    const page = mount();
    act(() => vi.advanceTimersByTime(20000));
    expect(page.getByRole('alert').textContent).toContain('기다리는 시간이 길어지고');
    expect(page.getByRole('button', { name: '카메라 다시 시작' })).toBeTruthy();
    await act(async () => pending.resolve(late.stream));
    expect(late.track.stop).toHaveBeenCalledOnce();
    expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
  });

  it('does not time out a camera that already has a usable frame', async () => {
    vi.useFakeTimers();
    getUserMedia.mockResolvedValueOnce(camera().stream);
    const page = mount();
    await act(async () => {});
    ready(page.getByLabelText('정면 카메라 미리보기') as HTMLVideoElement);
    act(() => vi.advanceTimersByTime(20000));
    expect(page.queryByRole('alert')).toBeNull();
    expect((page.getByRole('button', { name: '사진 촬영' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('stops the old camera before changing sides and discards a stale response', async () => {
    const pending = deferred(), oldCamera = camera(), newCamera = camera('user');
    getUserMedia.mockReturnValueOnce(pending.promise).mockResolvedValueOnce(newCamera.stream);
    const page = mount();
    fireEvent.click(page.getByRole('button', { name: '카메라 전환' }));
    await waitFor(() => expect(HTMLMediaElement.prototype.play).toHaveBeenCalled());
    await act(async () => pending.resolve(oldCamera.stream));
    const video = page.getByLabelText('정면 카메라 미리보기') as HTMLVideoElement;
    expect(oldCamera.track.stop).toHaveBeenCalledOnce();
    expect(video.srcObject).toBe(newCamera.stream);
    expect(getUserMedia.mock.calls[1][0].video.facingMode.ideal).toBe('user');
    page.unmount();
    expect(newCamera.track.stop).toHaveBeenCalledOnce();
  });

  it('survives StrictMode setup/cleanup without retaining a duplicate camera stream', async () => {
    const first = camera(), second = camera();
    getUserMedia.mockResolvedValueOnce(first.stream).mockResolvedValueOnce(second.stream);
    const page = render(<StrictMode><CameraCapture label="정면" onCapture={vi.fn()} onClose={vi.fn()} onChooseFile={vi.fn()} onNativeCapture={vi.fn()} /></StrictMode>);
    await waitFor(() => expect(HTMLMediaElement.prototype.play).toHaveBeenCalled());
    expect(first.track.stop).toHaveBeenCalledOnce();
    page.unmount();
    expect(second.track.stop).toHaveBeenCalledOnce();
  });

  it('stops a failed preview and can restart after an error', async () => {
    const failed = camera(), replacement = camera();
    getUserMedia.mockResolvedValueOnce(failed.stream).mockResolvedValueOnce(replacement.stream);
    vi.mocked(HTMLMediaElement.prototype.play).mockRejectedValueOnce(new DOMException('test only', 'NotAllowedError'));
    const page = mount();
    await page.findByRole('alert');
    expect(failed.track.stop).toHaveBeenCalled();
    fireEvent.click(page.getByRole('button', { name: '카메라 다시 시작' }));
    await waitFor(() => expect((page.getByLabelText('정면 카메라 미리보기') as HTMLVideoElement).srcObject).toBe(replacement.stream));
  });

  it('disables shooting when the camera disconnects', async () => {
    const device = camera(); getUserMedia.mockResolvedValue(device.stream);
    const page = mount();
    await waitFor(() => expect(HTMLMediaElement.prototype.play).toHaveBeenCalled());
    ready(page.getByLabelText('정면 카메라 미리보기') as HTMLVideoElement);
    act(() => device.track.dispatchEvent(new Event('ended')));
    expect((page.getByRole('button', { name: '사진 촬영' }) as HTMLButtonElement).disabled).toBe(true);
    expect(page.getByRole('alert').textContent).toContain('연결이 끊겼습니다');
  });

  it('supports Escape, a focus trap and closing when the page goes to the background', () => {
    getUserMedia.mockReturnValue(new Promise(() => {}));
    const page = mount(), dialog = page.getByRole('dialog');
    expect(document.activeElement).toBe(dialog);
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(page.getByRole('button', { name: '카메라 닫기' }));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(page.onClose).toHaveBeenCalledOnce();
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    fireEvent(document, new Event('visibilitychange'));
    expect(page.onClose).toHaveBeenCalledTimes(2);
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    page.unmount();
    expect(document.body.style.overflow).toBe('');
  });
});
