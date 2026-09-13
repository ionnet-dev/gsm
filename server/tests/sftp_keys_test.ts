import { assert, assertEquals } from "@std/assert";
import {
  canonicalKey,
  fingerprint,
  generatePassword,
  parsePublicKey,
  parseSftpUsername,
  sftpNameBase,
  shortId,
} from "../src/modules/sftp/keys.ts";

// Generated with ssh-keygen; fingerprints as `ssh-keygen -lf` prints them.
const ED25519 =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFql4NfbKiEZdoGJoH4S3wPJRDeX27tnttmWFMZgEnLA tester@laptop";
const ED25519_FP = "SHA256:rNv55uuVS9D4EbCtNrr3DjYOoNmaawLKiP2xfhax67c";
const RSA =
  "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQCpCpyE9s49bABV4LXX/JX5FiYE7mwfGQ9OXmAWmDdZzGHhKuEIVHvABd8ZoRZlPlMlkNUU0mlY5adeg+ZWvJI5N1RZMp0tmoFasFQXOFD1DB71v4bJO1nQbd4RKKF9k3vQXbGsfZax7fBP9lZb/ueWcJdsG8qXGOvY3lliuDBRPVLbwZtL9blOGSBQ+UX9LJIiYXu9EQb9sG+zIj+kULU8tEGWSRW/msrfjQorN9IExAQI5wrnAuL98WkDISnAxmXRyYhBUSslOMOoBKlOQ2x4GxTYlKqXSzDJ3ZI5XqBS4Dh0eAF4C70ahbQQmADQISi/Sw+Rs9UTnlIA/gCS+KHN98xI+Mp1K0sEXgNdPRyfyi4PaQ8UmudO972553mzQfEujB3upjnmZ3ttA0aUPUbpKa3ygYo4TLIjal7IkgulZyrtnIIbFgx3BtK4Rj41uFf/bOp3ajn+dSuezwxUQ75WziBNLcVl99/QJ+eo7Nzg994MlyV+IyJpJDSMK2xRAR0= rsa@box";
const RSA_FP = "SHA256:qGOX2YiU6hmBqQYAU48T07HtsXIZWXZWK9lb4j10+bI";

Deno.test("parsePublicKey reads ed25519 and RSA keys and fingerprints them like ssh-keygen", async () => {
  const ed = parsePublicKey(ED25519);
  assert(typeof ed !== "string");
  assertEquals(ed.type, "ssh-ed25519");
  assertEquals(ed.comment, "tester@laptop");
  assertEquals(await fingerprint(ed.blob), ED25519_FP);
  assertEquals(canonicalKey(ed), ED25519.split(" ").slice(0, 2).join(" "));
  const rsa = parsePublicKey(RSA);
  assert(typeof rsa !== "string");
  assertEquals(await fingerprint(rsa.blob), RSA_FP);
});

Deno.test("parsePublicKey explains what is wrong", () => {
  assertEquals(typeof parsePublicKey("-----BEGIN OPENSSH PRIVATE KEY-----"), "string");
  assertEquals(
    parsePublicKey("ssh-dss AAAA"),
    "Unsupported key type ssh-dss; use ed25519, ECDSA or RSA",
  );
  assertEquals(parsePublicKey("ssh-ed25519 !!!"), "The key is not valid base64");
  // An RSA blob labelled as ed25519.
  assertEquals(
    parsePublicKey("ssh-ed25519 " + RSA.split(" ")[1]),
    "The key data does not match its type",
  );
});

Deno.test("parsePublicKey refuses short RSA keys", () => {
  assertEquals(
    parsePublicKey(
      "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAAAgQCtGbt+6nQqxSeZuF9c+k7RIfnP8dkRfX+Fsrud4vV8JEaoE0kN6ByFKBNTnKQVg8pfdCPEb/t/OqI/sVc2G0udE28ZSjWZeRJf5YgdQ1MVN1iG70Dvlx3VvzCS9A0UbkNF01MwfS6LEgmUI1s7aIaWDKJhSRkWYyjSP76R0qXQTQ== weak"
        .replaceAll("'", ""),
    ),
    "RSA keys need at least 2048 bits",
  );
});

Deno.test("SFTP names and usernames", () => {
  assertEquals(sftpNameBase("Alice.Smith+gsm@example.com"), "alice-smith-gsm");
  assertEquals(sftpNameBase("@example.com"), "user");
  assertEquals(shortId("3f9a2c1b-0000-4000-8000-000000000000"), "3f9a2c1b");
  assertEquals(parseSftpUsername("Alice-Smith.3F9A2C1B"), {
    name: "alice-smith",
    shortId: "3f9a2c1b",
  });
  assertEquals(parseSftpUsername("alice"), null);
  assertEquals(parseSftpUsername("alice.3f9a2c1"), null);
  assertEquals(parseSftpUsername("al ice.3f9a2c1b"), null);
});

Deno.test("generatePassword uses the alphabet and length", () => {
  const p = generatePassword();
  assertEquals(p.length, 24);
  assert(/^[a-km-zA-HJ-NP-Z2-9]+$/.test(p));
  assert(generatePassword() !== p);
});
