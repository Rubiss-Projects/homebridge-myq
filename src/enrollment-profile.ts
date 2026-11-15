import { randomBytes, randomUUID, generateKeyPairSync } from 'node:crypto';
import forge from 'node-forge';

export const AUTH_HOSTS = ['partner-identity.myq-cloud.com', 'identity.myq-cloud.com', 'identity.myq.com', 'accounts.myq.com'];
export const MYQ_DOMAINS = ['myq-cloud.com', 'myq.com', 'myqops.com', 'myliftmaster.com'];
export const ENROLLMENT_MS = 15 * 60_000;

export function xml(value: string): string {
  return value.replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;'}[c]!));
}

/** Keys exist only in memory for this enrollment, never in the plugin package or profile. */
export function enrollmentCertificate(expiresAt: number) {
  const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const privateKey = forge.pki.privateKeyFromPem(keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString());
  const publicKey = forge.pki.publicKeyFromPem(keys.publicKey.export({ type: 'spki', format: 'pem' }).toString());
  const ca = forge.pki.createCertificate();
  ca.publicKey = publicKey;
  ca.serialNumber = '01' + randomBytes(15).toString('hex');
  ca.validity.notBefore = new Date(Date.now() - 300_000);
  ca.validity.notAfter = new Date(expiresAt + 300_000);
  const name = `myQ Temporary Setup ${randomBytes(3).toString('hex').toUpperCase()}`;
  ca.setSubject([{ name: 'commonName', value: name }]);
  ca.setIssuer(ca.subject.attributes);
  ca.setExtensions([{ name: 'basicConstraints', cA: true, critical: true },
    { name: 'keyUsage', keyCertSign: true, cRLSign: true, critical: true }]);
  ca.sign(privateKey, forge.md.sha256.create());
  const leaf = forge.pki.createCertificate();
  leaf.publicKey = publicKey;
  leaf.serialNumber = '02' + randomBytes(15).toString('hex');
  leaf.validity = ca.validity;
  leaf.setSubject([{ name: 'commonName', value: AUTH_HOSTS[0]! }]);
  leaf.setIssuer(ca.subject.attributes);
  leaf.setExtensions([{ name: 'basicConstraints', cA: false, critical: true },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
    { name: 'extKeyUsage', serverAuth: true },
    { name: 'subjectAltName', altNames: [...AUTH_HOSTS, ...MYQ_DOMAINS.flatMap(domain => [domain, `*.${domain}`])].map(value => ({ type: 2, value })) }]);
  leaf.sign(privateKey, forge.md.sha256.create());
  return { name, ca: forge.pki.certificateToPem(ca), cert: forge.pki.certificateToPem(leaf),
    key: forge.pki.privateKeyToPem(privateKey),
    der: Buffer.from(forge.asn1.toDer(forge.pki.certificateToAsn1(ca)).getBytes(), 'binary') };
}

export function pacFile(address: string, port: number, active: boolean): string {
  // Non-myQ traffic stays direct. myQ device writes are denied by the enrollment listener.
  return `function FindProxyForURL(url, host) {\n  var domains = ${JSON.stringify(MYQ_DOMAINS)};\n  for (var i = 0; i < domains.length; i++) {\n    if (host === domains[i] || host.slice(-(domains[i].length + 1)) === '.' + domains[i])\n      return ${JSON.stringify(active ? `PROXY ${address}:${port}` : 'DIRECT')};\n  }\n  return 'DIRECT';\n}\n`;
}

export function iphoneProfile(input: { id: string; ssid: string; password?: string; pacUrl: string; certificate: Buffer; certificateName: string; expiresAt: number }): string {
  const identifier = `dev.homebridge.myq.setup.${input.id}`;
  const common = (type: string, suffix: string, name: string) => `<key>PayloadType</key><string>${type}</string><key>PayloadVersion</key><integer>1</integer><key>PayloadIdentifier</key><string>${identifier}.${suffix}</string><key>PayloadUUID</key><string>${randomUUID()}</string><key>PayloadDisplayName</key><string>${xml(name)}</string>`;
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>
${common('Configuration', 'profile', 'myQ Temporary Setup')}
<key>PayloadDescription</key><string>Temporarily connects the official myQ sign-in to your Homebridge. This profile and its certificate are automatically removed after 15 minutes. Remove it after setup.</string>
<key>RemovalDate</key><date>${new Date(input.expiresAt).toISOString().replace(/\.\d{3}Z$/, 'Z')}</date>
<key>DurationUntilRemoval</key><real>${ENROLLMENT_MS / 1000}</real>
<key>PayloadContent</key><array><dict>
${common('com.apple.security.root', 'certificate', input.certificateName)}
<key>PayloadContent</key><data>${input.certificate.toString('base64')}</data>
</dict><dict>${common('com.apple.wifi.managed', 'wifi', 'myQ Setup Wi-Fi')}
<key>SSID_STR</key><string>${xml(input.ssid)}</string><key>EncryptionType</key><string>WPA</string>
${input.password ? `<key>Password</key><string>${xml(input.password)}</string>` : ''}
<key>AutoJoin</key><true/><key>ProxyType</key><string>Auto</string>
<key>ProxyPACURL</key><string>${xml(input.pacUrl)}</string><key>ProxyPACFallbackAllowed</key><false/>
</dict></array></dict></plist>`;
}
