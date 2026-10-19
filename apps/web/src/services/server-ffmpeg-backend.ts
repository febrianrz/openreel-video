import type { EncoderBackend, VideoExportSettings, Project } from "@openreel/core";
import { encodeAudioBufferToPcm16 } from "./native-ffmpeg-backend";

type EncoderCall = (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
function call(input: Record<string, unknown>) {
  const bridge=(window as Window & { __alterEncoder?: EncoderCall }).__alterEncoder;
  if (!bridge) throw new Error("Backend FFmpeg worker is unavailable");
  return bridge(input);
}
function base64(bytes: Uint8Array) {
  let binary="";
  for(let offset=0;offset<bytes.length;offset+=32768) binary+=String.fromCharCode(...bytes.subarray(offset,offset+32768));
  return btoa(binary);
}

export class ServerFFmpegBackend implements EncoderBackend {
  readonly requiresWebCodecsClamping=false;
  readonly needsFrameThrottling=true;
  readonly normalizesProResToH264=true;
  readonly audioBeforeVideo=true;
  result: Record<string,unknown> | null=null;
  private id="";
  private bytes=0;
  private channels=2;
  private canvas: OffscreenCanvas | null=null;
  private context: OffscreenCanvasRenderingContext2D | null=null;
  async start(settings: VideoExportSettings, _project: Project) {
    this.canvas=new OffscreenCanvas(settings.width,settings.height);
    this.context=this.canvas.getContext("2d",{willReadFrequently:true});
    if (!this.context) throw new Error("Unable to initialize backend frame renderer");
    this.channels=settings.audioSettings.channels;
    const started=await call({op:"start",width:settings.width,height:settings.height,frameRate:settings.frameRate,sampleRate:settings.audioSettings.sampleRate,channels:this.channels,format:settings.format,bitrate:settings.bitrate});
    this.id=String(started.id);
  }
  async addVideoFrame(frame: ImageBitmap, _timestampSec: number, _durationSec: number) {
    if (!this.canvas || !this.context) throw new Error("Encoder not started");
    this.context.clearRect(0,0,this.canvas.width,this.canvas.height);
    this.context.drawImage(frame,0,0,this.canvas.width,this.canvas.height);
    const data=this.context.getImageData(0,0,this.canvas.width,this.canvas.height).data;
    await call({op:"frame",id:this.id,data:base64(new Uint8Array(data.buffer,data.byteOffset,data.byteLength))});
    this.bytes+=data.byteLength;
  }
  async addAudioBuffer(buffer: AudioBuffer) {
    await call({op:"audio",id:this.id,data:base64(new Uint8Array(encodeAudioBufferToPcm16(buffer,this.channels)))});
  }
  closeAudio() {}
  getBytesWritten() { return this.bytes; }
  async finalize() { this.result=await call({op:"finish",id:this.id}); }
  async abort() { if(this.id) await call({op:"abort",id:this.id}); }
}
