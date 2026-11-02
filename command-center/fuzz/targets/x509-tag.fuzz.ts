import { createPublicKey } from 'node:crypto';
import { splitSignedTag, verifySignedMessage } from '../../src/update/cms.ts';

// The X.509 signature at the end of a release tag object (update/cms.ts): third-party bytes until
// they verify. The input is a whole tag object. cms.ts answers every bad input with a reason and
// never throws, so any throw is a finding, and so is an ok result that does not name the pinned
// signer. The pinned key is the owner's real signing key, embedded here because the bundled target
// has no import.meta.url; the seed is a real tag it signed, so the verified path is reached too.
const SIGNER = createPublicKey(`-----BEGIN PUBLIC KEY-----
MIICIjANBgkqhkiG9w0BAQEFAAOCAg8AMIICCgKCAgEA0MwsyM7L7kURfByCxnV0
Wocfyx9+SVv3VBSZcQrw3c703Y8JXazPd2Dwf5wrNAPuLE7D9WAwrQThojeqgYsR
cOnWykEfkYA/YnI+K6+ccl/80avByx9qOH++jMIx6xAtKT3ogenPUAwexYwAWd7d
4JetB07iRnN+YwvRRCj8llbQakht3J4bsetQ/YUpD08u1Y2mcfKgy75uJutyLjYF
AH//1J4NgInHtKrvYAv10hHW7/aSfOWJsW49pqNG0rbPfBd/22XHNOXWkdMOWf26
MaVfAwF3qFcpsOTi7wYeDfOCNGjYCdh9Rq7A195iTLCFn4nqT0dkZ+HK+1jd+Xm2
udpV2FpvTIV403lNaBDWBngoj6j2OrAQIoOOJPKIXck/SyfWjPqK2l7F/VaFsYw2
HZszYtHcRyskaFta4TDPmKn+gsZywoN3ZZnpVmxaeoyGmcFUUOxjo6xUwyA0sdq1
uMNINgUqaQHKkdvARQJjrXh9imTAP+0587qrRe7yleQHRtoyXOKmx0C7uVbwxaSp
9U4tJHk4liQQ4LF8ud9gJAHgNMfKMeSUohMrM4ZrUI7Sd2zCIalqPtYM7P5fyBSp
w5gz9oV/3c7F/emRmB/YjwttnZK+sD+yG4u8O8COvbBqRONkrA3xQqshzOSBF/WU
wLYNI7ZcEr6aM0pFx+UQ4DUCAwEAAQ==
-----END PUBLIC KEY-----
`);
const PINNED = [{ name: 'owner', key: SIGNER }];

export function fuzz(data: Buffer): void {
  const split = splitSignedTag(Buffer.from(data));
  if (split === null) return;
  const result = verifySignedMessage(split.payload, split.signatureBlock, PINNED);
  if (result.ok && result.signer !== 'owner') throw new Error(`verified as ${result.signer}, which is not pinned`);
}
