# Evidence5 attempt history

Evidence5 needed several prospective protocols before the revised4 campaign could complete. Only the four revised4 primary blocks contribute to its 32 scheduled positions. Earlier canaries, blocks and provider-free dry runs remain separate. No observed score determined whether an attempt was repeated.

| Protocol | Actual inference attempts | Disposition | Known conservative list-price upper |
|---|---|---|---:|
| Pilot | Canaries `12ac1701-addb-42c9-8106-5d640d350053`, `9af2c148-5cd0-4991-b623-1a118519ede0`; block 1 `a2677358-f622-4914-954a-21b11126104e`; block 2 `70da950e-f783-41c9-8b3d-ed3578828cf7` | Block 2 lost transport certainty after dispatch; the VM was recovered safely. Seven cells have known usage; the eighth is unknown. The pilot stopped. | USD10.4112256 across known cells; full amount unknown |
| Revised | Canary `8e7ff56e-1487-4c22-a22d-3d068614a927`; block 1 `afd12c32-f525-4387-8938-b9480c892ea2` | One Codex cell ended with a capacity error after tool use and no usage record. The protocol's usage gate stopped the campaign. | USD4.341887 across known cells; full amount unknown |
| Revised2 | Canary `dbef2fb2-319c-4700-ae13-183aa4f0605e`; block 1 `1d379b3a-2233-495e-b800-f0b0e0066ddc` | Original whole-block eligibility failed after a Claude nonresponse; the protocol stopped. | USD4.9957642 |
| Revised3 | Canary `a9e73b70-24e8-4000-90a9-089c190cf3ef`; blocks 1–2 `a608dba7-6b50-45bd-8818-cdc34e6d544e`, `4bef5a98-919d-4b12-9d25-1f9160efd215` | Block 2 had a structural Codex rejection with complete usage. Its frozen rule did not permit replay. Blocks 3–4 never ran. | USD9.1683226 |
| Revised4 | Canary `594b89dc-d2d4-42e1-af4e-18893f9af57b`; four primary blocks listed in the [campaign record](README.md) | Completed the frozen 32-position design: 29 accepted, three missing with observed zero usage. | USD13.9602382 including the excluded canary |

The pilot and revised protocols also had provider-free dry runs. The revised prelive attempt `8602569b-5621-4453-b0a5-3b4e7999f75e` failed before LiveRunning; its recovery was safe and it consumed no inference session. Revised3 dry run `5c1c21cd-f65d-498e-b3db-f84ffc0e907b` and revised4 dry run `2b2020be-2932-4c12-844a-509c932eb34f` likewise used zero inference sessions. They are not additional priced cells.

The **prior-to-revised4 subtotal of USD28.9171994** covers only cells with known usage. It is **not** a full historical upper bound because two earlier cells have unknown usage; neither is priced as zero. The revised4 USD70 ceiling and USD25 hypothetical reserve apply only to revised4. Actual OAuth charges are unknown. Normal attempts closed with the exact VM off, VHD detached and network offline; the two abnormal attempts have separate safe-recovery records. The private frozen preregistrations and immutable receipts preserve their full details without publishing raw transcripts or credentials.
