// Minimal Java class that writes each argument on its own line to stdout.
// Used by Candidate A (direct JVM) Tier-1 proof in windows-metachar tests:
// proves java.exe spawned directly by Node delivers args byte-for-byte
// without any cmd.exe %VAR% expansion.
//
// Compile at test time with: javac ArgsEcho.java
// Run: java -cp <dir> ArgsEcho <args...>
public class ArgsEcho {
  public static void main(String[] args) {
    for (String arg : args) {
      System.out.println(arg);
    }
  }
}
