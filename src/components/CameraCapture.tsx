import { useEffect, useId, useRef, useState } from 'react';
import { captureVideoPhoto } from '../utils/photos';

type Props = {
  label: string;
  onCapture: (photo: string) => void;
  onClose: () => void;
  onChooseFile: () => void;
  onNativeCapture: () => void;
};

function cameraError(error: unknown): string {
  switch ((error as { name?: string })?.name) {
    case 'NotAllowedError': case 'PermissionDeniedError': case 'SecurityError':
      return '카메라 권한이 차단되어 있습니다. 브라우저의 사이트 설정에서 카메라를 허용한 뒤 다시 시도해주세요. 앱 안에서 열었다면 Safari 또는 Chrome으로 열어주세요.';
    case 'NotFoundError': case 'DevicesNotFoundError':
      return '연결된 카메라를 찾을 수 없습니다. 카메라를 연결하거나 사진 파일을 선택해주세요.';
    case 'NotReadableError': case 'TrackStartError': case 'AbortError':
      return '카메라를 시작하지 못했습니다. 다른 앱에서 카메라를 사용 중인지 확인한 뒤 다시 시도해주세요.';
    default:
      return '카메라 화면을 열지 못했습니다. 다시 시도하거나 기기 카메라 또는 사진 파일을 사용해주세요.';
  }
}

export function CameraCapture({ label, onCapture, onClose, onChooseFile, onNativeCapture }: Props) {
  const headingId = useId();
  const dialog = useRef<HTMLDivElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const [facing, setFacing] = useState<'environment' | 'user'>('environment');
  const [attempt, setAttempt] = useState(0);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const [mirrored, setMirrored] = useState(false);
  const capturing = useRef(false);
  const startupTimeout = useRef<number | undefined>();
  const releaseCamera = useRef<() => void>(() => {});
  const close = useRef(onClose);
  close.current = () => { releaseCamera.current(); onClose(); };

  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    dialog.current?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); close.current(); }
      if (event.key !== 'Tab') return;
      const elements = dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), [href], input:not(:disabled), [tabindex="0"]');
      if (!elements?.length) return;
      const first = elements[0], last = elements[elements.length - 1];
      if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) {
        event.preventDefault(); last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialog.current)) {
        event.preventDefault(); first.focus();
      }
    };
    // Leaving the page stops capture instead of retaining a background camera.
    const visibility = () => { if (document.hidden) close.current(); };
    document.addEventListener('keydown', keydown);
    document.addEventListener('visibilitychange', visibility);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', keydown);
      document.removeEventListener('visibilitychange', visibility);
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, []);

  useEffect(() => {
    let disposed = false;
    let stream: MediaStream | null = null;
    const element = video.current;
    const stop = () => { stream?.getTracks().forEach(track => { if (track.readyState !== 'ended') track.stop(); }); };
    const ended = () => {
      if (disposed) return;
      window.clearTimeout(startupTimeout.current);
      setReady(false);
      setError('카메라 연결이 끊겼습니다. 다시 시작하거나 사진 파일을 선택해주세요.');
    };
    const release = () => {
      disposed = true;
      window.clearTimeout(startupTimeout.current);
      stream?.getVideoTracks().forEach(track => track.removeEventListener('ended', ended));
      stop();
      if (element) element.srcObject = null;
    };
    releaseCamera.current = release;
    setReady(false); setError('');
    startupTimeout.current = window.setTimeout(() => {
      disposed = true;
      stop();
      if (element) element.srcObject = null;
      setReady(false);
      setError('카메라 응답을 기다리는 시간이 길어지고 있습니다. 브라우저의 권한 요청을 확인하거나 기기 카메라 또는 사진 파일을 사용해주세요.');
    }, 20000);
    void (async () => {
      try {
        if (window.isSecureContext === false || !navigator.mediaDevices?.getUserMedia) {
          window.clearTimeout(startupTimeout.current);
          if (!disposed) setError('이 브라우저에서는 실시간 카메라를 사용할 수 없습니다. Safari 또는 Chrome에서 보안 연결로 열거나 아래에서 사진을 선택해주세요.');
          return;
        }
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            audio: false,
            video: { facingMode: { ideal: facing }, width: { ideal: 1280 }, height: { ideal: 1280 } },
          });
        } catch (error) {
          if (disposed) return;
          if ((error as { name?: string }).name !== 'OverconstrainedError') throw error;
          stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: true });
        }
        // Permission may resolve after closing or switching cameras.
        if (disposed || !element) { stop(); return; }
        const track = stream.getVideoTracks()[0];
        if (!track || track.readyState === 'ended') { stop(); throw new DOMException('No live camera', 'NotFoundError'); }
        track.addEventListener('ended', ended);
        setMirrored((track.getSettings?.().facingMode ?? facing) === 'user');
        element.srcObject = stream;
        await element.play();
        if (!disposed && element.readyState >= 2 && element.videoWidth > 0 && element.videoHeight > 0) {
          window.clearTimeout(startupTimeout.current);
          setReady(true);
        }
      } catch (error) {
        stop();
        if (!disposed) {
          window.clearTimeout(startupTimeout.current);
          setReady(false); setError(cameraError(error));
        }
      }
    })();
    return release;
  }, [facing, attempt]);

  const frameReady = () => {
    const element = video.current;
    if (element?.srcObject && element.readyState >= 2 && element.videoWidth > 0 && element.videoHeight > 0) {
      window.clearTimeout(startupTimeout.current);
      setReady(true);
    }
  };
  const capture = () => {
    if (!ready || !video.current || capturing.current) return;
    capturing.current = true;
    try {
      const photo = captureVideoPhoto(video.current);
      releaseCamera.current();
      setReady(false);
      onCapture(photo);
    }
    catch (error) { setError(error instanceof Error ? error.message : '촬영하지 못했습니다. 다시 시도해주세요.'); }
    finally { capturing.current = false; }
  };
  const choose = (callback: () => void) => {
    // Release hardware before opening the native camera, even if the OS picker
    // blocks the event handler before React can unmount the dialog.
    releaseCamera.current();
    setReady(false);
    callback();
  };
  const button = 'min-h-[48px] rounded-xl border px-4 font-bold disabled:opacity-50';
  return (
    <div className="fixed inset-0 z-50 bg-black/70 p-3 sm:p-5 flex items-center justify-center">
      <div ref={dialog} role="dialog" aria-modal="true" aria-labelledby={headingId} tabIndex={-1}
        className="w-full max-w-xl max-h-[95dvh] overflow-y-auto rounded-3xl bg-white p-4 sm:p-5 outline-none">
        <div className="flex items-center justify-between gap-3 mb-3">
          <h2 id={headingId} className="text-xl font-bold">{label} 카메라 촬영</h2>
          <button type="button" onClick={() => close.current()} className={button} aria-label="카메라 닫기">닫기</button>
        </div>
        <div className="relative mx-auto aspect-square max-h-[55dvh] bg-black rounded-2xl overflow-hidden">
          <video ref={video} autoPlay playsInline muted onLoadedData={frameReady} onCanPlay={frameReady}
            aria-label={label + ' 카메라 미리보기'}
            className={'w-full h-full object-contain' + (mirrored ? ' -scale-x-100' : '')} />
          {!ready && !error && <p role="status" className="absolute inset-0 flex items-center justify-center text-white px-5 text-center">
            카메라를 준비하고 있어요. 권한 요청이 뜨면 카메라 사용을 허용해주세요.
          </p>}
        </div>
        <p className="text-sm text-secondary my-3">얼굴과 머리 끝까지 화면에 담아주세요. 촬영한 사진은 확인 후 상담에 사용됩니다.</p>
        {error && <p role="alert" className="text-error text-sm my-3">{error}</p>}
        <div className="grid grid-cols-2 gap-2">
          <button type="button" disabled={!ready} onClick={capture} className={button + ' bg-primary text-white'}>사진 촬영</button>
          {error ? <button type="button" onClick={() => setAttempt(value => value + 1)} className={button}>카메라 다시 시작</button>
            : <button type="button" onClick={() => setFacing(value => value === 'environment' ? 'user' : 'environment')} className={button}>카메라 전환</button>}
          <button type="button" onClick={() => choose(onChooseFile)} className={button}>사진 파일 선택</button>
          <button type="button" onClick={() => choose(onNativeCapture)} className={button}>기기 카메라 사용</button>
        </div>
      </div>
    </div>
  );
}
