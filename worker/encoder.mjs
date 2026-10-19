import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, appendFile, stat, rm } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function createEncoderBridge(api, token) {
  const jobs = new Map();
  async function dispose(job) {
    if (job.child && job.child.exitCode === null) { job.child.kill("SIGKILL"); await job.done.catch(() => {}); }
    await rm(job.directory, { recursive: true, force: true });
  }
  async function handle(_source, input) {
    if (input.op === "start") {
      const { width, height, frameRate, sampleRate, channels, format, bitrate } = input;
      if (![width,height].every(n=>Number.isInteger(n)&&n>0&&n<=4096) || !Number.isFinite(frameRate) || frameRate<=0 || frameRate>120 || ![1,2].includes(channels) || ![22050,24000,44100,48000,96000].includes(sampleRate) || !["mp4","webm","mov"].includes(format)) throw new Error("Invalid backend encoder settings");
      const id=randomUUID();
      const directory=await mkdtemp(join(tmpdir(),"openreel-encode-"));
      jobs.set(id,{ directory, width,height,frameRate,sampleRate,channels,format,bitrate:Math.max(100,Math.min(100000,Number(bitrate)||12000)), audioBytes:0, frames:0, child:null, error:"" });
      return { id };
    }
    const job=jobs.get(input.id);
    if (!job) throw new Error("Encoder job not found");
    if (input.op === "audio") {
      if (job.child) throw new Error("Audio must be delivered before video frames");
      const bytes=Buffer.from(input.data,"base64");
      job.audioBytes+=bytes.length;
      if (job.audioBytes>500000000) throw new Error("Audio exceeds encoder limit");
      await appendFile(join(job.directory,"audio.pcm"),bytes);
      return {};
    }
    if (input.op === "frame") {
      const bytes=Buffer.from(input.data,"base64");
      if (bytes.length!==job.width*job.height*4 || ++job.frames>216000) throw new Error("Invalid frame or encoder frame limit exceeded");
      if (!job.child) {
        job.path=join(job.directory,`export.${job.format}`);
        const args=["-hide_banner","-loglevel","error","-y","-f","rawvideo","-pixel_format","rgba","-video_size",`${job.width}x${job.height}`,"-framerate",String(job.frameRate),"-i","pipe:0"];
        if (job.audioBytes) args.push("-f","s16le","-ar",String(job.sampleRate),"-ac",String(job.channels),"-i",join(job.directory,"audio.pcm"));
        args.push("-c:v",job.format==="webm"?"libvpx-vp9":"libx264","-b:v",`${job.bitrate}k`,"-pix_fmt","yuv420p");
        if (job.format!=="webm") args.push("-preset","veryfast","-movflags","+faststart");
        if (job.audioBytes) args.push("-c:a",job.format==="webm"?"libopus":"aac","-b:a","192k");
        args.push(job.path);
        job.child=spawn(process.env.FFMPEG_PATH || "ffmpeg",args,{stdio:["pipe","ignore","pipe"]});
        job.child.stderr.on("data",chunk=>{ job.error=(job.error+chunk.toString()).slice(-3000); });
        job.done=new Promise((resolve,reject)=>{
          job.child.once("error",reject);
          job.child.once("exit",code=>code===0?resolve():reject(new Error(job.error || `FFmpeg exited ${code}`)));
        });
        job.done.catch(()=>{});
        job.child.stdin.on("error",()=>{});
      }
      await new Promise((resolve,reject)=>job.child.stdin.write(bytes,error=>error?reject(error):resolve()));
      return { bytes:bytes.length };
    }
    if (input.op === "finish") {
      try {
        if (!job.child) throw new Error("Export has no video frames");
        job.child.stdin.end();
        await job.done;
        const info=await stat(job.path);
        if (!info.size || info.size>500000000) throw new Error("Export is empty or exceeds 500 MB");
        const filename=`openreel-${Date.now()}.${job.format}`;
        const response=await fetch(new URL("/api/video/assets",api),{method:"POST",headers:{Authorization:`Bearer ${token}`,"Content-Type":job.format==="webm"?"video/webm":job.format==="mov"?"video/quicktime":"video/mp4","X-Filename":filename,"X-Asset-Kind":"export"},body:createReadStream(job.path),duplex:"half",signal:AbortSignal.timeout(600000)});
        const result=await response.json();
        if (!response.ok) throw new Error(result.error || "Backend export upload failed");
        return { ...result.asset, storage:"backend", encoder:"ffmpeg" };
      } finally { jobs.delete(input.id); await dispose(job); }
    }
    if (input.op === "abort") { jobs.delete(input.id); await dispose(job); return {}; }
    throw new Error("Unknown encoder operation");
  }
  return { handle, dispose:async()=>{await Promise.all([...jobs.values()].map(dispose));jobs.clear();} };
}
