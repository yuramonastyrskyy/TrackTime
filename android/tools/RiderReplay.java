// Desktop replay of rider identification on a recorded clip, with the app's own
// RiderVision + RiderEngine (same models), so changes can be checked without a phone.
// Writes one JSON line per described frame: {"lap":n,"T":ms,"frame":i,"r":<RiderEngine.process output>};
// feed those frames to js/riders.js (RiderRun) to see who led each lap.
//
//   curl -LO https://repo.maven.apache.org/maven2/com/microsoft/onnxruntime/onnxruntime/1.22.0/onnxruntime-1.22.0.jar
//   P=android/app/src/main/java/io/github/yuramonastyrskyy/tracktime
//   javac -cp onnxruntime-1.22.0.jar -d /tmp/rr $P/RiderVision.java $P/RiderEngine.java android/tools/RiderReplay.java
//   java -Dfps=29.71 -cp onnxruntime-1.22.0.jar:/tmp/rr RiderReplay part1.mp4 events.csv 1 out.jsonl \
//     android/app/src/main/assets/riders/yolox_tiny.onnx android/app/src/main/assets/riders/osnet_x0_25.onnx \
//     <top.x,top.y,inner.x,inner.y from the log> 640
// -Dfps: the clip's average frame rate (ffprobe avg_frame_rate); -Dtypes=lap,ignored adds more windows.
// Needs ffmpeg. Frames are scaled to 360 wide (the app's half-size frames); 640 = height for 9:16.
import io.github.yuramonastyrskyy.tracktime.*;
import java.io.*;
import java.nio.file.*;
import java.util.*;
import javax.imageio.ImageIO;
import java.awt.image.BufferedImage;

public class RiderReplay {
  public static void main(String[] a) throws Exception {
    String vid=a[0], ev=a[1], part=a[2], out=a[3], det=a[4], reid=a[5];
    String[] ls=a[6].split(","); float[] line=new float[4]; for(int i=0;i<4;i++) line[i]=Float.parseFloat(ls[i]);
    int W=360, H=Integer.parseInt(a[7]); double fps=Double.parseDouble(System.getProperty("fps","29.97002997")); int every=a.length>8?Integer.parseInt(a[8]):1;
    double start=-1; List<Double> laps=new ArrayList<>();
    for(String l: Files.readAllLines(Paths.get(ev))){ String[] c=l.split(",",-1); if(c.length<5||!c[1].equals(part)) continue;
      if(c[3].equals("start")) start=Double.parseDouble(c[2]); if(System.getProperty("types","lap").contains(c[3])) laps.add(Double.parseDouble(c[2])); }
    RiderEngine eng=new RiderEngine(Files.readAllBytes(Paths.get(det)),Files.readAllBytes(Paths.get(reid)),4,(rgb,w,h)->{
      try{ BufferedImage im=new BufferedImage(w,h,BufferedImage.TYPE_INT_RGB); for(int y=0;y<h;y++)for(int x=0;x<w;x++){int i=(y*w+x)*3; im.setRGB(x,y,(rgb[i]&255)<<16|(rgb[i+1]&255)<<8|(rgb[i+2]&255));}
        ByteArrayOutputStream b=new ByteArrayOutputStream(); ImageIO.write(im,"jpg",b); return b.toByteArray(); }catch(Exception e){return null;}});
    eng.setLine(line);
    Process p=new ProcessBuilder("ffmpeg","-v","error","-i",vid,"-fps_mode","passthrough","-vf","scale="+W+":"+H+":flags=area","-f","rawvideo","-pix_fmt","rgb24","-").redirectError(ProcessBuilder.Redirect.DISCARD).start();
    DataInputStream in=new DataInputStream(new BufferedInputStream(p.getInputStream(),1<<22));
    byte[] f=new byte[W*H*3]; PrintWriter pw=new PrintWriter(new FileWriter(out)); int i=-1; boolean bgSet=false; long t0=System.currentTimeMillis(); int proc=0;
    while(true){ try{ in.readFully(f);}catch(EOFException e){break;} i++; double t=i/fps;
      if(!bgSet){ if(start>=0 && t>=start){ eng.setBackground(f,W,H); bgSet=true;} continue; }
      int lap=-1; for(int k=0;k<laps.size();k++) if(t>=laps.get(k)-0.5&&t<=laps.get(k)+8) {lap=k;break;}
      if(lap<0 || i%every!=0) { continue; }
      proc++; String r=eng.process(f,W,H,t*1000);
      if(r!=null) pw.println("{\"lap\":"+(lap+1)+",\"T\":"+laps.get(lap)*1000+",\"frame\":"+i+",\"r\":"+r+"}");
    }
    pw.close(); System.err.printf("frames in windows %d, detector ran %d, det ms avg %.1f, wall %ds%n",proc,eng.framesDetected,eng.detMsTotal/(double)Math.max(1,eng.framesDetected),(System.currentTimeMillis()-t0)/1000);
  }
}
