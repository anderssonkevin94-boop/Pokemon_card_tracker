import { useEffect, useRef, useState } from 'react'

// In-app camera with a card-outline guide. Falls back to the native file
// picker (which offers the camera on iOS) when getUserMedia is unavailable.
export default function CameraCapture({
  onCapture,
  onCancel,
}: {
  onCapture: (blob: Blob) => void
  onCancel: () => void
}) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    async function start() {
      if (!navigator.mediaDevices?.getUserMedia) {
        setError('no-camera-api')
        return
      }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: 'environment',
            width: { ideal: 2048 },
            height: { ideal: 2048 },
          },
          audio: false,
        })
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop())
          return
        }
        streamRef.current = stream
        if (videoRef.current) {
          videoRef.current.srcObject = stream
          await videoRef.current.play()
        }
      } catch {
        if (!cancelled) setError('denied')
      }
    }
    start()
    return () => {
      cancelled = true
      streamRef.current?.getTracks().forEach((t) => t.stop())
    }
  }, [])

  function capture() {
    const video = videoRef.current
    if (!video || video.videoWidth === 0) return
    const canvas = document.createElement('canvas')
    canvas.width = video.videoWidth
    canvas.height = video.videoHeight
    canvas.getContext('2d')!.drawImage(video, 0, 0)
    canvas.toBlob(
      (blob) => {
        if (blob) onCapture(blob)
      },
      'image/jpeg',
      0.92,
    )
  }

  function onFilePicked(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (file) onCapture(file)
    else onCancel()
  }

  if (error) {
    return (
      <div className="camera-overlay" style={{ justifyContent: 'center', padding: 24 }}>
        <p style={{ textAlign: 'center', marginBottom: 16 }}>
          {error === 'denied'
            ? 'Camera access was denied. You can allow it in Settings, or pick a photo instead.'
            : 'In-app camera is not available here. Use the photo picker instead.'}
        </p>
        <button className="btn btn-primary btn-block" onClick={() => fileRef.current?.click()}>
          Take / choose photo
        </button>
        <button className="btn btn-block" onClick={onCancel}>Cancel</button>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          capture="environment"
          hidden
          onChange={onFilePicked}
        />
      </div>
    )
  }

  return (
    <div className="camera-overlay">
      <video ref={videoRef} playsInline muted />
      <div className="camera-guide" />
      <button className="camera-cancel" onClick={onCancel}>Cancel</button>
      <div className="camera-controls">
        <button className="shutter" aria-label="Take photo" onClick={capture} />
      </div>
    </div>
  )
}
