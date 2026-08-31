// SPDX-License-Identifier: MIT
import java.net.InetAddress;
import java.net.UnknownHostException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Arrays;
import java.util.concurrent.TimeUnit;

public final class ResolverProbe {
    public static void main(String[] args) {
        try {
            System.exit(run(args));
        } catch (Exception ignored) {
            System.out.println("{\"error\":\"resolver_fixture_failed\"}");
            System.exit(1);
        }
    }

    private static int run(String[] args) throws Exception {
        if (args.length != 2 || !(args[0].equals("wrapper") || args[0].equals("child"))) {
            return 2;
        }
        String hosts = System.getProperty("jdk.net.hosts.file");
        // Fail before InetAddress initializes if startup injection is absent or wrong.
        if (hosts == null || !Path.of(hosts).equals(Path.of(args[1])) || !Files.isRegularFile(Path.of(hosts))) {
            System.out.println("{\"error\":\"hosts_property_missing_or_mismatched\"}");
            return 2;
        }
        String[] addresses = Arrays.stream(InetAddress.getAllByName("repository.e1.invalid"))
            .map(InetAddress::getHostAddress).sorted().toArray(String[]::new);
        boolean unknownRejected = false;
        try {
            InetAddress.getAllByName("absent.e1.invalid");
        } catch (UnknownHostException expected) {
            unknownRejected = true;
        }
        boolean localhost = allLoopback("localhost");
        boolean computer = allLoopback(System.getenv("COMPUTERNAME"));
        System.out.println("{\"role\":\"" + args[0] + "\",\"jdk_major\":" + Runtime.version().feature()
            + ",\"property_matches\":true,\"known_addresses\":[\"" + String.join("\",\"", addresses)
            + "\"],\"unknown_rejected\":" + unknownRejected + ",\"localhost_loopback\":" + localhost
            + ",\"computer_loopback\":" + computer + "}");
        if (!Arrays.equals(addresses, new String[] { "127.0.0.42", "127.0.0.43" })
            || !unknownRejected || !localhost || !computer) {
            return 1;
        }
        if (args[0].equals("child")) return 0;

        String java = Path.of(System.getProperty("java.home"), "bin",
            System.getProperty("os.name").startsWith("Windows") ? "java.exe" : "java").toString();
        Process child = new ProcessBuilder(java, "-cp", System.getProperty("java.class.path"),
            "ResolverProbe", "child", args[1])
            .redirectOutput(ProcessBuilder.Redirect.INHERIT)
            .redirectError(ProcessBuilder.Redirect.DISCARD).start();
        try {
            return child.waitFor(10, TimeUnit.SECONDS) ? child.exitValue() : 3;
        } finally {
            if (child.isAlive()) {
                child.destroyForcibly();
                if (!child.waitFor(5, TimeUnit.SECONDS)) throw new IllegalStateException();
            }
        }
    }

    private static boolean allLoopback(String host) throws UnknownHostException {
        InetAddress[] addresses = InetAddress.getAllByName(host);
        return addresses.length > 0 && Arrays.stream(addresses).allMatch(InetAddress::isLoopbackAddress);
    }
}
