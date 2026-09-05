# Asset License

All source code in this repository is licensed separately under the MIT License in `LICENSE`.

Unless a future file or directory states otherwise, first-party non-code assets for Reef Rush are
copyright (c) 2026 Matthew W. Rider and licensed under the Creative Commons Attribution 4.0
International license (CC BY 4.0). That includes original art, audio, animation, user-interface
illustrations, narrative text presented as game content, captured media, and marketing assets.

You may share and adapt those first-party assets for any purpose, including reuse outside Reef
Rush, provided you give appropriate attribution, indicate whether changes were made, and do not
imply endorsement by the original creator.

Third-party assets, tools, fonts, and dependency packages remain under their own respective
licenses and notices.

## Original Sunlit assets (Task 9, Slice 9A)

The four GLBs below are first-party artwork, authored procedurally for Reef Rush
from original mesh construction, palette, proportions, branch patterns and
animation in `assets/source/build_assets.py` and
`assets/source/sunlit-assets.json`. No third-party models, textures, images,
fonts, scans or animation clips are incorporated. Blender is an authoring tool,
not an artwork source. The editable Python generator is MIT-licensed source
code; the JSON art data and generated artwork are CC BY 4.0 as stated above.
No `.blend` archive is needed to edit or reproduce the artwork.

| Output under `public/assets/`         | Original content                                                          |
| ------------------------------------- | ------------------------------------------------------------------------- |
| `fish/sunfin.glb`                     | Orange/cream Sunfin, teal dorsal fin, eyes, separate fins and `swim` loop |
| `props/reef-kit.glb`                  | Warm limestone, branching peach coral, lavender fan and jade seagrass     |
| `courses/sunlit-shoals.visual.glb`    | Five authored solid bases, shared reef props and low sand terraces        |
| `courses/sunlit-shoals.collision.glb` | Only the five named primitive proxy meshes; no decorative mesh physics    |

Suggested attribution: **"Reef Rush original Sunlit assets, copyright (c) 2026
Matthew W. Rider, CC BY 4.0; changes: [describe any changes]."**

### Reproduction

Use the repository's pinned Node version and Blender **4.5 LTS**. The initial
outputs use **Blender 4.5.13 LTS**. The generator rejects other Blender major/minor
versions. Fixed seed: `9042026`. Run from the project root:

```text
npm run assets:generate
npm run assets:generate -- --blender "<Blender executable>" --output-root "<output assets directory>"
npm run assets:validate
npm run assets:validate -- --asset-root "<output assets directory>"
npm run test -- tests/assets/assetPipeline.test.ts
```

The executable defaults to `blender`, or the optional `BLENDER` environment
variable. The output root contains the `fish`, `props` and `courses` directories.
The runner always passes `--background --factory-startup --python-exit-code 1`
before `--python`, propagates Blender failures and validates its outputs.
No UI, network, decoder or image resource is required. Tool installations and
absolute machine paths do not belong in the repository.

Geometry is constructed in game meters, **+Y up / +Z forward**, rotated into
Blender's authoring basis as `(x, -z, y)`, then exported with glTF Y-up enabled.
Dimensions are baked into mesh vertices; collider nodes have unit scale.
The exporter slides the sampled one-second fin animation to time zero.
GLB JSON is canonically serialized after export; the binary mesh/animation
payload is Blender's export. Exact binary repeatability is expected for the
same Blender build/platform, not promised across Blender updates or platforms.

### Original asset profile and collider contract

`tools/asset-profile.mjs` is a reusable offline validator.
`tools/asset-profile.d.mts` supplies the typed `StaticSolidExtras`,
`NoncollidingExtras`, `StaticSolidSource` and `AssetReport` contract. It has no
runtime integration. `validateGlb(bytes, assetPath, liveSolids)` accepts the
current typed Sunlit solids directly; `validateProject` also checks both
project license files. The command uses the portable JSON source; the focused
tests additionally compare that entire source solid array and both course
outputs to the live `sunlitShoals.ts` definition, preventing silent source drift.

Each scene has `extras.reefRush` with `profile: "reef-rush-original-v1"`, its
relative asset path, `up: "+Y"`, `forward: "+Z"`, `metersPerUnit: 1` and `seed`.
The supported glTF 2.0 profile is intentionally narrow: one exhaustive flat
scene; uniquely named mesh nodes; indexed triangles; tightly packed float32
positions/normals; uint16/uint32 indices; opaque lit PBR color materials; and,
only for the fish, linear quaternion animation on the three moving fin nodes.
Geometry and materials are shared between repeated prop instances.

Two GLB chunks (JSON then BIN), a single embedded buffer and valid accessor
ranges/bounds are required. Unsupported features are rejected, not ignored:
external resources, images/textures, all extensions/decoders, skins, morphs,
sparse/interleaved accessors, node matrices/hierarchies, lights and cameras.
Reported triangles and draw calls count **instances**, not just unique meshes;
draw calls are primitive instances before any renderer-specific passes.
Budgets are 2 MiB per GLB, 5 MiB combined, 10,000 fish triangles, 100,000 course
visual triangles and 256 course mesh nodes. The profile also caps the other
nonfish outputs at 100,000 triangles and all outputs at 256 mesh nodes.
Before decoding any accessor values, the validator caps their aggregate at
1,000,000 scalar components per file, including aliased or unused accessors.
Small buffers cannot bypass this work and memory budget through repeated views.

Every static visual base and collision node is named exactly its course ID.
Its `node.extras.reefRush` value follows this versioned discriminated contract:

```json
{
  "version": 1,
  "role": "static-solid",
  "id": "west-ledge",
  "category": "environment",
  "primitive": { "type": "box", "halfExtents": [3, 2, 14] },
  "transform": {
    "position": [-13, -6, 24],
    "rotation": [0, 0, 0, 1],
    "scale": [1, 1, 1]
  }
}
```

The other primitive variant is `{ "type": "sphere", "radius": 4 }`; category is
`"environment"` or `"hazard"`. Rotation is quaternion `[x, y, z, w]`.
This metadata uses **game/glTF coordinates**, not Blender coordinates. Metadata
must match the authored course exactly; exported float32 transforms, bounds
and primitive surfaces use an absolute `1e-5` tolerance. Local proxy meshes
are centered at the origin with actual primitive dimensions; node translation
and rotation place them in the course. The validator also checks closed proxy
surfaces. Consumers should create primitive colliders from this metadata,
**never detailed coral triangle physics**.

The five IDs are `sand-bed`, `west-ledge`, `coral-mound-east`,
`coral-mound-west`, and `urchin-outcrop` (the sole static hazard).
Each occurs exactly once in each course output. Dynamic gates, currents,
checkpoints and pearls are intentionally absent.

Decorative nodes instead have exactly
`{ "version": 1, "role": "decoration", "collides": false }`;
fish parts use the same form with `role: "fish-part"`. Course decoration names
start with `decor-`. Decoration stays outside the open route/spawn ribbon
(`-9 <= x <= 9`, above `y = -7.5`); low terraces stay below it. This is a static
visibility/placement guard, not a gameplay or human art-quality assessment.
Named fish nodes include `sunfin-body`, `sunfin-eye-left`, `sunfin-eye-right`,
`fin-tail`, `fin-dorsal`, `fin-anal`, `fin-pectoral-left` and
`fin-pectoral-right`. The tail and both pectoral fins have nonconstant tracks
with matching first/last rotations in the `swim` clip.
