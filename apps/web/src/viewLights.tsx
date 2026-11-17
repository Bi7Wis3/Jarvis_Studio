// The lights of Options > Lighting inside a 3D view (the main view, and the Lighting page's overview): the ambient
// light, the directional, point and spot lights with their own ambient share, and the environment's light panels.
// Lights locked to the model stand in the world; the others turn with the view camera (see lightMath.ts).

import { useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { Environment, Lightformer } from '@react-three/drei';
import { MathUtils, Object3D, Quaternion, Vector3, type Camera, type Group, type PerspectiveCamera } from 'three';
import {
    lightPoint, sphericalPoint, type DirectionalLight as DirectionalSpec, type Lightformer as FormerSpec, type LightingSettings,
    type PointLight as PointSpec, type SpotLight as SpotSpec,
} from '@jarvis/core/settings';

/** The main view's camera, kept current while it draws, for the overview to show (and to turn its lights by). */
export const viewCamera = {
    known: false,
    position: new Vector3(200, 150, 400),
    quaternion: new Quaternion(),
    target: new Vector3(),
    fov: 32,
    aspect: 1.5,
    /** Changes whenever the camera does. */
    version: 0,
};

const at = new Vector3();

function publish(camera: Camera, controls: unknown): void {
    const c = viewCamera;
    const getTarget = (controls as { getTarget?: (out: Vector3) => Vector3 } | null)?.getTarget;
    if (getTarget) {
        getTarget.call(controls, at);
    }
    const perspective = camera as PerspectiveCamera;
    if (c.known && c.position.equals(camera.position) && c.quaternion.equals(camera.quaternion) && c.target.equals(at)
        && c.aspect === perspective.aspect) {
        return;
    }
    c.known = true;
    c.position.copy(camera.position);
    c.quaternion.copy(camera.quaternion);
    c.target.copy(at);
    c.fov = perspective.fov ?? c.fov;
    c.aspect = perspective.aspect ?? c.aspect;
    c.version++;
}

/** Distance of a directional light from the origin, and the size of the box its shadow covers (mm). */
const LIGHT_DISTANCE = 1500;
const SHADOW_HALF = 1000;
/** How far the shadows of point and spot lights reach (mm). */
const SHADOW_REACH = 20000;

function Directional({ light }: { light: DirectionalSpec }) {
    const p = sphericalPoint(light.azimuth, light.elevation, LIGHT_DISTANCE);
    return light.shadow ? (
        <directionalLight
            position={p}
            color={light.color}
            intensity={light.intensity}
            castShadow
            shadow-mapSize={[2048, 2048]}
            shadow-bias={-0.0004}
            shadow-normalBias={0.5}
            shadow-camera-left={-SHADOW_HALF}
            shadow-camera-right={SHADOW_HALF}
            shadow-camera-top={SHADOW_HALF}
            shadow-camera-bottom={-SHADOW_HALF}
            shadow-camera-near={1}
            shadow-camera-far={LIGHT_DISTANCE * 3}
        />
    ) : (
        <directionalLight position={p} color={light.color} intensity={light.intensity} />
    );
}

// Point and spot lights do not fade with distance (decay 0), as SolidWorks' view lights do not: Brightness means the
// same for every kind of light.
function Point({ light }: { light: PointSpec }) {
    return (
        <pointLight
            position={lightPoint(light)}
            color={light.color}
            intensity={light.intensity}
            distance={0}
            decay={0}
            castShadow={light.shadow}
            shadow-mapSize={[1024, 1024]}
            shadow-bias={-0.0005}
            shadow-camera-near={1}
            shadow-camera-far={SHADOW_REACH}
        />
    );
}

function Spot({ light }: { light: SpotSpec }) {
    const target = useMemo(() => new Object3D(), []);
    return (
        <>
            <primitive object={target} position={[light.targetX, light.targetY, light.targetZ]} />
            <spotLight
                position={lightPoint(light)}
                target={target}
                color={light.color}
                intensity={light.intensity}
                angle={MathUtils.degToRad(light.coneAngle)}
                penumbra={0}
                distance={0}
                decay={0}
                castShadow={light.shadow}
                shadow-mapSize={[1024, 1024]}
                shadow-bias={-0.0005}
                shadow-camera-near={1}
                shadow-camera-far={SHADOW_REACH}
            />
        </>
    );
}

function Former({ former }: { former: FormerSpec }) {
    return (
        <Lightformer
            form={former.form}
            color={former.color}
            intensity={former.intensity}
            position={sphericalPoint(former.azimuth, former.elevation, former.distance)}
            scale={former.form === 'rect' ? [former.width, former.height, 1] : former.width}
            // Faces the model.
            target={[0, 0, 0]}
        />
    );
}

/** The lights of `locked` (fixed to the model) or of the others. */
function Lights({ lighting, locked }: { lighting: LightingSettings; locked: boolean }) {
    const mine = <T extends { on: boolean; lockToModel: boolean }>(list: T[]) => list.filter((l) => l.on && l.lockToModel === locked);
    return (
        <>
            {mine(lighting.directional).map((l) => <Directional key={l.id} light={l} />)}
            {mine(lighting.point).map((l) => <Point key={l.id} light={l} />)}
            {mine(lighting.spot).map((l) => <Spot key={l.id} light={l} />)}
        </>
    );
}

/**
 * The lighting in a 3D view. `view`: the camera turn the lights that are not locked to the model follow; without it
 * they follow this view's own camera, which is then published as `viewCamera` (the main view).
 */
export function ViewLights({ lighting, view }: { lighting: LightingSettings; view?: Quaternion }) {
    const turning = useRef<Group>(null);
    const camera = useThree((s) => s.camera);
    const controls = useThree((s) => s.controls);
    // After camera-controls has moved the camera (it updates first), before the frame is drawn.
    useFrame(() => {
        turning.current?.quaternion.copy(view ?? camera.quaternion);
        if (!view) {
            publish(camera, controls);
        }
    });
    const { ambient, environment } = lighting;
    const shares = [...lighting.directional, ...lighting.point, ...lighting.spot].filter((l) => l.on && l.ambient > 0);
    const formers = environment.formers.filter((f) => f.on);
    return (
        <>
            {ambient.on && <ambientLight color={ambient.color} intensity={ambient.intensity} />}
            {shares.map((l) => <ambientLight key={`ambient-${l.id}`} color={l.color} intensity={l.ambient} />)}
            <Lights lighting={lighting} locked />
            <group ref={turning}>
                <Lights lighting={lighting} locked={false} />
            </group>
            {environment.on && (
                // The environment map is drawn once; a new key draws it again when its panels change.
                <Environment key={JSON.stringify([formers, environment.strength])} resolution={256} environmentIntensity={environment.strength}>
                    {formers.map((f) => <Former key={f.id} former={f} />)}
                </Environment>
            )}
        </>
    );
}
