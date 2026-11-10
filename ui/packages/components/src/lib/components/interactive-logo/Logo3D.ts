import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { attachViewportLogoTilt } from "./logoTilt.js";

declare global {
  interface Window {
    logoUri: string;
    logoFaceUri: string;
  }
}

// Type for color overrides from CSS variables
export interface LogoColorOverrides {
  outlineColor?: number; // Used for both front and back outlines
  backgroundColor?: number;
}

// Return type for the scene initializer
export interface LogoSceneControls {
  updateColors: (overrides: LogoColorOverrides) => void;
  dispose: () => void;
}

// Layout options for the scene initializer
export interface LogoLayoutOptions {
  /** Multiplies the model's base render size (default 1). */
  scale?: number;
  /** Center the model vertically in the canvas instead of anchoring it near the bottom. */
  anchorCenter?: boolean;
}

// Default configuration values
const CONFIG = {
  COLORS: {
    FRONT_FACE: 0x6670fe,
    BACK_FACE: 0x362712,
    SIDE_FACES: 0x6670fe,
    FRONT_FACE_OPACITY: 0.1,
    BACK_FACE_OPACITY: 0,
    SIDE_FACES_OPACITY: 1.0,
    FRONT_OUTLINE: 0x4137ff,
    BACK_OUTLINE: 0x4137ff,
    FRONT_OUTLINE_OPACITY: 1.0,
    BACK_OUTLINE_OPACITY: 0.25,
  },
  VIEW_SIZE: 0.175,
  BOTTOM_OFFSET_PX: 48,
  // Threshold for determining if animation should continue (in radians)
  ANIMATION_THRESHOLD: 0.001,
  MIN_RENDER_SIZE: 1,
  MAX_RENDER_WIDTH: 720,
  MAX_RENDER_HEIGHT: 360,
  MAX_PIXEL_RATIO: 1.5,
};

export function getLogoRenderSize(width: number, height: number) {
  return {
    width: Math.max(CONFIG.MIN_RENDER_SIZE, Math.min(width, CONFIG.MAX_RENDER_WIDTH)),
    height: Math.max(CONFIG.MIN_RENDER_SIZE, Math.min(height, CONFIG.MAX_RENDER_HEIGHT)),
  };
}

export function getLogoPixelRatio(devicePixelRatio: number) {
  return Math.max(1, Math.min(devicePixelRatio, CONFIG.MAX_PIXEL_RATIO));
}

export function initLogoScene(
  container: HTMLDivElement,
  colorOverrides?: LogoColorOverrides,
  layout?: LogoLayoutOptions,
): LogoSceneControls {
  const modelScaleMultiplier = layout?.scale ?? 1;
  const anchorCenter = layout?.anchorCenter ?? false;

  // Track materials that need updating when colors change
  const outlineMaterials: THREE.LineBasicMaterial[] = [];

  // Track animation frame for cleanup
  let animationFrameId: number | null = null;
  let isAnimating = false;
  let disposed = false;
  let lastRenderSize = getLogoRenderSize(container.clientWidth, container.clientHeight);

  // Merge overrides with defaults
  const COLORS = {
    ...CONFIG.COLORS,
    FRONT_OUTLINE: colorOverrides?.outlineColor ?? CONFIG.COLORS.FRONT_OUTLINE,
    BACK_OUTLINE: colorOverrides?.outlineColor ?? CONFIG.COLORS.BACK_OUTLINE,
  };

  const scene = new THREE.Scene();
  // Transparent background so the page's grid treatment shows through behind
  // the roundel. Note: transparent WebGL canvases have previously corrupted
  // sibling compositor layers in WKWebView until pointer movement triggered
  // another frame; if that resurfaces, the initial render below is the place
  // to force extra frames.
  scene.background = null;

  const aspect = lastRenderSize.width / lastRenderSize.height;
  const viewSize = CONFIG.VIEW_SIZE;
  const camera = new THREE.OrthographicCamera(
    -viewSize * aspect,
    viewSize * aspect,
    viewSize,
    -viewSize,
    0.1,
    1000,
  );
  camera.position.set(0, 0, 5);

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setSize(lastRenderSize.width, lastRenderSize.height);
  renderer.setPixelRatio(getLogoPixelRatio(window.devicePixelRatio));
  container.appendChild(renderer.domElement);

  const loader = new GLTFLoader();
  let model: THREE.Group | null = null;
  let frontOverlay: THREE.Group | null = null;
  let backOverlay: THREE.Group | null = null;

  // Mouse interaction variables
  let targetRotationX = 0;
  let targetRotationY = 0;

  // Event handler references for cleanup
  let disposeViewportTilt: (() => void) | null = null;
  let onWindowResize: (() => void) | null = null;
  let resizeObserver: ResizeObserver | null = null;

  const { vertexShader, fragmentShader } = getShaders();

  function applyFaceColors(object: THREE.Object3D) {
    object.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        disposeMaterials(child.material);
        child.material = new THREE.ShaderMaterial({
          vertexShader,
          fragmentShader,
          uniforms: {
            frontColor: { value: new THREE.Color(COLORS.FRONT_FACE) },
            backColor: { value: new THREE.Color(COLORS.BACK_FACE) },
            sideColor: { value: new THREE.Color(COLORS.SIDE_FACES) },
            frontOpacity: { value: COLORS.FRONT_FACE_OPACITY },
            backOpacity: { value: COLORS.BACK_FACE_OPACITY },
            sideOpacity: { value: COLORS.SIDE_FACES_OPACITY },
          },
          side: THREE.DoubleSide,
          transparent: true,
          depthWrite: true,
        });
      }
    });
  }

  function addOutlinesToOverlay(
    object: THREE.Object3D,
    zOffset: number,
    outlineColor: number,
    outlineOpacity: number,
  ) {
    object.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        disposeMaterials(child.material);
        child.material = new THREE.MeshBasicMaterial({
          color: COLORS.FRONT_FACE,
          transparent: true,
          opacity: 0,
        });

        const edgesGeometry = new THREE.EdgesGeometry(child.geometry, 1);
        const outlineMaterial = new THREE.LineBasicMaterial({
          color: outlineColor,
          linewidth: 1,
          transparent: outlineOpacity < 1.0,
          opacity: outlineOpacity,
        });
        outlineMaterials.push(outlineMaterial);
        const edges = new THREE.LineSegments(edgesGeometry, outlineMaterial);

        edges.position.copy(child.position);
        edges.position.z += zOffset;
        edges.rotation.copy(child.rotation);
        edges.scale.copy(child.scale);

        child.parent?.add(edges);
      }
    });
  }

  // Render-on-demand animation loop
  function animate() {
    if (disposed || !model) {
      isAnimating = false;
      return;
    }

    // Smooth rotation interpolation
    model.rotation.y += (targetRotationY - model.rotation.y) * 0.05;
    model.rotation.x += (targetRotationX - model.rotation.x) * 0.05;

    syncOverlays();

    renderScene();

    // Only continue animating if rotation hasn't settled
    const needsAnimation =
      Math.abs(targetRotationY - model.rotation.y) > CONFIG.ANIMATION_THRESHOLD ||
      Math.abs(targetRotationX - model.rotation.x) > CONFIG.ANIMATION_THRESHOLD;

    if (needsAnimation) {
      animationFrameId = requestAnimationFrame(animate);
    } else {
      isAnimating = false;
    }
  }

  // Request a render/animation frame if not already animating
  function requestRender() {
    if (!disposed && !isAnimating) {
      isAnimating = true;
      animationFrameId = requestAnimationFrame(animate);
    }
  }

  function renderScene() {
    if (disposed) return;
    renderer.render(scene, camera);
  }

  function syncOverlays() {
    if (!model) return;

    if (frontOverlay) {
      frontOverlay.rotation.copy(model.rotation);
      frontOverlay.position.copy(model.position);
      frontOverlay.scale.copy(model.scale);
    }
    if (backOverlay) {
      backOverlay.rotation.copy(model.rotation);
      backOverlay.position.copy(model.position);
      backOverlay.scale.copy(model.scale);
      backOverlay.position.z = model.position.z - 0.05;
    }
  }

  function containerRenderSize(): { width: number; height: number } | null {
    const width = container.clientWidth;
    const height = container.clientHeight;

    if (width === 0 || height === 0) {
      return null;
    }

    return getLogoRenderSize(width, height);
  }

  loader.load(
    window.logoUri ?? "/camber-logo.glb",
    (gltf) => {
      if (disposed) {
        disposeObject3D(gltf.scene);
        return;
      }
      model = gltf.scene;
      scene.add(model);

      applyFaceColors(model);

      const box = new THREE.Box3().setFromObject(model);
      const center = box.getCenter(new THREE.Vector3());
      const size = box.getSize(new THREE.Vector3());

      // Center the model
      model.position.sub(center);

      // Function to update model scale and camera based on viewport size
      function updateModelAndCamera() {
        if (!model) return;

        const renderSize = containerRenderSize();
        if (!renderSize) return;

        const viewportWidth = renderSize.width;
        const viewportHeight = renderSize.height;
        const renderSizeChanged =
          viewportWidth !== lastRenderSize.width || viewportHeight !== lastRenderSize.height;
        lastRenderSize = renderSize;

        // Calculate the scale factor based on the viewport size
        const scaleFactor = 100 / Math.min(viewportWidth, viewportHeight);

        // Update the model's scale
        const maxDim = Math.max(size.x, size.y, size.z);
        const scale = scaleFactor * maxDim * modelScaleMultiplier;
        model.scale.set(scale, scale, scale);

        // Update camera projection
        const aspect = viewportWidth / viewportHeight;
        const viewSize = CONFIG.VIEW_SIZE;
        camera.left = -viewSize * aspect;
        camera.right = viewSize * aspect;
        camera.top = viewSize;
        camera.bottom = -viewSize;
        camera.updateProjectionMatrix();

        // Update renderer size
        if (renderSizeChanged) {
          renderer.setSize(viewportWidth, viewportHeight);
        }

        // Update model position
        if (anchorCenter) {
          model.position.y = 0;
        } else {
          const modelHeight = size.y * scale;
          const viewportBottomOffset = CONFIG.BOTTOM_OFFSET_PX / viewportHeight;
          model.position.y = -viewSize + modelHeight / 2 + viewportBottomOffset * viewSize * 2;
        }

        // Update model horizontal position to be centered
        model.position.x = 0;

        // setSize can clear the drawing buffer; render immediately so layout transitions do not
        // show a blank frame while the next animation frame is pending.
        syncOverlays();
        renderScene();
        requestRender();
      }

      // Initial update
      updateModelAndCamera();

      if (typeof ResizeObserver === "undefined") {
        onWindowResize = () => updateModelAndCamera();
        window.addEventListener("resize", onWindowResize);
      } else {
        resizeObserver = new ResizeObserver(() => updateModelAndCamera());
        resizeObserver.observe(container);
      }

      // Listen once at the viewport boundary so the logo responds everywhere in
      // the app. The handler only updates two numeric targets; the existing
      // render-on-demand loop performs at most one render per frame and stops
      // entirely as soon as the interpolation settles.
      disposeViewportTilt = attachViewportLogoTilt((rotationX, rotationY) => {
        targetRotationX = rotationX;
        targetRotationY = rotationY;
        requestRender();
      });

      // Initial render
      requestRender();

      // Load face overlay once and clone for front/back
      loader.load(
        window.logoFaceUri ?? "/camber-face-logo.glb",
        (faceGltf) => {
          if (disposed) {
            disposeObject3D(faceGltf.scene);
            return;
          }
          // Setup front overlay
          frontOverlay = faceGltf.scene;
          frontOverlay.position.copy(model!.position);
          frontOverlay.rotation.copy(model!.rotation);
          frontOverlay.scale.copy(model!.scale);
          addOutlinesToOverlay(
            frontOverlay,
            0.0,
            COLORS.FRONT_OUTLINE,
            COLORS.FRONT_OUTLINE_OPACITY,
          );
          scene.add(frontOverlay);

          // Clone for back overlay instead of loading again
          backOverlay = faceGltf.scene.clone(true);
          backOverlay.position.copy(model!.position);
          backOverlay.position.z -= 0.05;
          backOverlay.rotation.copy(model!.rotation);
          backOverlay.scale.copy(model!.scale);
          addOutlinesToOverlay(
            backOverlay,
            -0.05,
            COLORS.BACK_OUTLINE,
            COLORS.BACK_OUTLINE_OPACITY,
          );
          scene.add(backOverlay);

          // Render with overlays
          requestRender();
        },
        undefined,
        (error) => {
          if (!disposed) console.warn("Could not load face overlay:", error);
        },
      );
    },
    undefined,
    (error) => {
      if (!disposed) console.error("Error loading model:", error);
    },
  );

  // Return controls for updating colors and cleanup
  return {
    updateColors: (overrides: LogoColorOverrides) => {
      if (disposed) return;
      const outlineColor = overrides.outlineColor ?? CONFIG.COLORS.FRONT_OUTLINE;
      outlineMaterials.forEach((mat) => {
        mat.color.setHex(outlineColor);
      });
      requestRender();
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;

      // Cancel any pending animation frame
      if (animationFrameId !== null) {
        cancelAnimationFrame(animationFrameId);
        animationFrameId = null;
      }
      isAnimating = false;

      // Remove event listeners
      if (onWindowResize) {
        window.removeEventListener("resize", onWindowResize);
      }
      resizeObserver?.disconnect();
      disposeViewportTilt?.();
      disposeViewportTilt = null;

      // Release every scene-owned GPU allocation before destroying the
      // context. renderer.dispose() alone only clears renderer-level caches;
      // geometries, materials, and the WebGL drawing buffer otherwise survive
      // until WebKit eventually collects the context.
      disposeObject3D(scene);
      outlineMaterials.length = 0;
      model = null;
      frontOverlay = null;
      backOverlay = null;
      renderer.renderLists.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
      scene.clear();
    },
  };
}

function disposeObject3D(object: THREE.Object3D) {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>();

  object.traverse((child) => {
    if (!(child instanceof THREE.Mesh || child instanceof THREE.LineSegments)) return;
    geometries.add(child.geometry);
    const childMaterials = Array.isArray(child.material) ? child.material : [child.material];
    for (const material of childMaterials) {
      materials.add(material);
      for (const value of Object.values(material)) {
        if (value instanceof THREE.Texture) textures.add(value);
      }
    }
  });

  for (const texture of textures) texture.dispose();
  for (const material of materials) material.dispose();
  for (const geometry of geometries) geometry.dispose();
}

function disposeMaterials(material: THREE.Material | THREE.Material[]) {
  const materials = Array.isArray(material) ? material : [material];
  for (const item of materials) {
    for (const value of Object.values(item)) {
      if (value instanceof THREE.Texture) value.dispose();
    }
    item.dispose();
  }
}

// Shader functions
function getShaders() {
  const vertexShader = `
    varying vec3 vNormal;

    void main() {
      vNormal = normalize(normalMatrix * normal);
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `;

  const fragmentShader = `
  uniform vec3 frontColor;
  uniform vec3 backColor;
  uniform vec3 sideColor;
  uniform float frontOpacity;
  uniform float backOpacity;
  uniform float sideOpacity;
  varying vec3 vNormal;

  void main() {
    vec3 normal = normalize(vNormal);

    float zComponent = normal.z;
    float frontBackFactor = abs(zComponent);

    vec3 frontBackColor = zComponent > 0.0 ? frontColor : backColor;
    float frontBackOpacity = zComponent > 0.0 ? frontOpacity : backOpacity;

    // Use a sharper transition - only mix when clearly on the side
    // For front/back faces (frontBackFactor > 0.5), use pure front/back color
    float mixFactor = smoothstep(0.3, 0.5, frontBackFactor);

    vec3 color = mix(sideColor, frontBackColor, mixFactor);
    float opacity = mix(sideOpacity, frontBackOpacity, mixFactor);

    // Apply gamma correction (linear to sRGB) for correct color display
    vec3 gammaCorrected = pow(color, vec3(1.0 / 2.2));
    gl_FragColor = vec4(gammaCorrected, opacity);
  }
`;

  return { vertexShader, fragmentShader };
}
