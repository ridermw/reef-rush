import {
  Color,
  DirectionalLight,
  Fog,
  Group,
  HemisphereLight,
  Scene,
} from 'three';
import type { CourseDefinition } from '../course/courseDefinition';

export function attachUnderwaterEnvironment(
  scene: Scene,
  root: Group,
  visuals: CourseDefinition['visuals'],
  releases: Array<() => void>,
): void {
  const previousBackground = scene.background;
  const previousFog = scene.fog;
  releases.push(() => {
    scene.background = previousBackground;
    scene.fog = previousFog;
    root.removeFromParent();
  });
  scene.background = new Color(visuals.waterColor);
  scene.fog = new Fog(visuals.waterColor, 25, 130);
  root.add(new HemisphereLight('#d1f7f4', visuals.seabedColor, 2.4));
  const sunlight = new DirectionalLight('#fff3d6', 2.5);
  sunlight.position.set(-15, 25, -10);
  root.add(sunlight);
}
