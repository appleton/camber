import { registryIconUrl, type ACPRegistryAgent } from "./agentRegistry";
import { DEFAULT_AGENT_SERVER, LOCAL_AGENT_SERVER } from "./agentServers";

// The filled Camber brand mark, copied verbatim from the app icon
// self-contained SVG so the first-party Camber agent (and its local, badged
// variant) get an icon URL the same way registry agents do, and every surface
// that masks an agent iconUrl renders it without special-casing. Consumed as a
// CSS mask, so only the alpha matters, not the fill.
const CAMBER_BRAND_PATH =
  "M2.79989 4.28935C3.08545 4.30563 3.38729 4.35252 3.6872 4.43901C4.26898 4.60679 4.86742 4.93164 5.32869 5.49021C6.07132 4.41058 7.38408 2.897 9.5541 1.80342C7.02181 1.16559 4.32457 2.14725 2.79989 4.28935ZM10.6818 2.50457C8.52349 3.42283 7.19739 4.81149 6.42473 5.86549C6.55114 5.88522 6.68012 5.91639 6.81029 5.96135C7.38777 6.16083 7.91236 6.60506 8.31385 7.36098C9.16663 7.21815 9.84147 7.38666 10.3486 7.74954C10.4376 7.81323 10.5194 7.88143 10.5944 7.95279C10.9265 6.58122 11.1892 4.56348 10.6818 2.50457ZM11.5594 8.65807C12.2935 8.66124 12.9303 8.91364 13.4333 9.25555C13.6924 9.43169 13.9215 9.63517 14.1154 9.84671C14.8845 7.31115 13.9928 4.5559 11.9094 2.94735C12.3037 5.20925 11.9262 7.32808 11.5594 8.65807ZM13.6202 11.035C13.4779 10.7842 13.2033 10.4427 12.8086 10.1744C12.3186 9.84131 11.6815 9.64563 10.9203 9.8578C10.7777 9.89757 10.6251 9.87873 10.4964 9.80547C10.3676 9.73222 10.2735 9.61061 10.2349 9.46764C10.1606 9.19306 9.99509 8.86284 9.70202 8.65314C9.45995 8.47992 9.05988 8.33789 8.38478 8.47773L5.70379 13.9607C8.68375 15.1126 12.0897 13.874 13.6202 11.035ZM4.70562 13.4727C2.74197 12.2937 1.61273 10.1871 1.6111 7.99965C1.61087 7.69283 1.36196 7.44428 1.05514 7.44451C0.748316 7.44474 0.499772 7.69365 0.5 8.00048C0.502058 10.7713 2.04697 13.436 4.70617 14.7363C8.42648 16.5554 12.9171 15.0141 14.7362 11.2938C16.5553 7.57352 15.014 3.08294 11.2937 1.26384C7.57339 -0.555254 3.08281 0.985986 1.26372 4.7063C1.16501 4.90816 1.19763 5.1496 1.34635 5.31804C1.49507 5.48647 1.73062 5.54874 1.94315 5.47579C2.1911 5.39069 2.77593 5.3326 3.37932 5.50661C3.95837 5.67359 4.50814 6.0387 4.80352 6.75858C4.85974 6.89559 4.96833 7.00448 5.10519 7.06107C5.24204 7.11766 5.39583 7.11727 5.53239 7.05999C5.78122 6.95561 6.11963 6.8983 6.44751 7.01156C6.72576 7.10768 7.07959 7.35536 7.38696 7.98895L4.70562 13.4727Z";

// The brand mark is a filled shape, so it has no stroke to widen; painting a
// thin same-colour stroke around the fill emboldens the silhouette just enough
// to stop it reading thin at small sizes. A stroke grows the outline on both
// sides, so keep this small (its full width lands on the mark's apparent
// weight). Only the mask's alpha matters downstream, so the colours are moot.
const CAMBER_ROUNDEL_STROKE_WIDTH = "0.25";

// The brand mark fills its 0–16 artboard edge to edge, so it reads a touch
// bigger than the sibling agent icons, which carry a little built-in padding.
// Shrink it a hair about the artboard centre (8,8) to match the others. Shared
// by the plain and badged variants so both roundels render at the same size.
const CAMBER_ROUNDEL_SCALE = 0.93;
const CAMBER_ROUNDEL_TRANSFORM = `translate(8 8) scale(${CAMBER_ROUNDEL_SCALE}) translate(-8 -8)`;

// The filled brand roundel as mask-ready markup: the mark, emboldened with a
// thin same-colour stroke and shrunk via the shared transform. When maskId is
// given the roundel is wrapped in an untransformed group carrying the mask, so
// the badge knockout stays fixed at the corner while only the roundel scales.
function brandRoundel(maskId?: string): string {
  const maskAttr = maskId ? ` mask="url(#${maskId})"` : "";
  return (
    `<g${maskAttr}><g transform="${CAMBER_ROUNDEL_TRANSFORM}">` +
    `<path d="${CAMBER_BRAND_PATH}" fill="#000" fill-rule="evenodd" clip-rule="evenodd" stroke="#000" stroke-width="${CAMBER_ROUNDEL_STROKE_WIDTH}" stroke-linejoin="round" stroke-linecap="round"/>` +
    "</g></g>"
  );
}

const CAMBER_ROUNDEL_ICON_SVG = [
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">',
  brandRoundel(),
  "</svg>",
].join("");

export const CAMBER_ROUNDEL_ICON_URL = `data:image/svg+xml,${encodeURIComponent(CAMBER_ROUNDEL_ICON_SVG)}`;

const SYSTEM_PATH =
  "M14 14H12.5H12V15H4V14H3.50001H2.00001V12.5V4.90001L2.00001 4.85217C1.99996 4.47359 1.99992 4.10491 2.02543 3.79267C2.05345 3.44978 2.11955 3.04518 2.32699 2.63804C2.61461 2.07356 3.07356 1.61461 3.63804 1.32699C4.04518 1.11955 4.44978 1.05345 4.79267 1.02543C5.10491 0.99992 5.47359 0.999964 5.85217 1.00001L5.90001 1.00001H10.1L10.1479 1.00001C10.5264 0.999964 10.8951 0.99992 11.2074 1.02543C11.5502 1.05345 11.9548 1.11955 12.362 1.32699C12.9265 1.61461 13.3854 2.07356 13.673 2.63804C13.8805 3.04518 13.9466 3.44978 13.9746 3.79267C14.0001 4.1049 14.0001 4.47359 14 4.85216V4.85217V4.85218L14 4.90001V12.5V14ZM3.6635 3.31903C3.50001 3.63989 3.50001 4.05993 3.50001 4.90001V11V12.5H5.00001H11H12.5V11V4.90001C12.5 4.05993 12.5 3.63989 12.3365 3.31903C12.1927 3.03678 11.9632 2.80731 11.681 2.6635C11.3601 2.50001 10.9401 2.50001 10.1 2.50001H5.90001C5.05993 2.50001 4.63989 2.50001 4.31903 2.6635C4.03678 2.80731 3.80731 3.03678 3.6635 3.31903ZM5.00001 5.60001C5.00001 5.03996 5.00001 4.75993 5.10901 4.54602C5.20488 4.35786 5.35786 4.20488 5.54602 4.10901C5.75993 4.00001 6.03996 4.00001 6.60001 4.00001H9.40001C9.96007 4.00001 10.2401 4.00001 10.454 4.10901C10.6422 4.20488 10.7951 4.35786 10.891 4.54602C11 4.75993 11 5.03996 11 5.60001V8.00001H5.00001V5.60001ZM8.00001 10.25C8.00001 9.8358 8.3358 9.50001 8.75001 9.50001H10.25C10.6642 9.50001 11 9.8358 11 10.25C11 10.6642 10.6642 11 10.25 11H8.75001C8.3358 11 8.00001 10.6642 8.00001 10.25Z";

const BADGE_HOLE_MASK =
  '<mask id="badge-hole"><rect width="16" height="16" fill="#fff"/><circle cx="11" cy="11" r="6" fill="#000"/></mask>';
// Same brand roundel as the plain Camber icon, with the badge hole knocked
// out of its bottom-right corner.
const LOCAL_ROUNDEL_MARKUP = brandRoundel("badge-hole");
const LOCAL_SYSTEM_PATH = `<path d="${SYSTEM_PATH}" fill="#000" fill-rule="evenodd" clip-rule="evenodd" transform="translate(6 6) scale(0.625)"/>`;

const LOCAL_AGENT_ROUNDEL_ICON_SVG = [
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">',
  BADGE_HOLE_MASK,
  LOCAL_ROUNDEL_MARKUP,
  "</svg>",
].join("");

export const LOCAL_AGENT_ROUNDEL_ICON_URL = `data:image/svg+xml,${encodeURIComponent(LOCAL_AGENT_ROUNDEL_ICON_SVG)}`;

const LOCAL_AGENT_SYSTEM_ICON_SVG = [
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">',
  LOCAL_SYSTEM_PATH,
  "</svg>",
].join("");

export const LOCAL_AGENT_SYSTEM_ICON_URL = `data:image/svg+xml,${encodeURIComponent(LOCAL_AGENT_SYSTEM_ICON_SVG)}`;

// The "system" badge is drawn at 62.5% in the bottom-right corner, and a
// circular hole is knocked out of the roundel underneath so the badge stays
// legible on any background. The icon is consumed as a CSS mask, so only the
// alpha channel matters, not the paint colors.
const LOCAL_AGENT_ICON_SVG = [
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">',
  BADGE_HOLE_MASK,
  LOCAL_ROUNDEL_MARKUP,
  LOCAL_SYSTEM_PATH,
  "</svg>",
].join("");

export const LOCAL_AGENT_ICON_URL = `data:image/svg+xml,${encodeURIComponent(LOCAL_AGENT_ICON_SVG)}`;

export function agentServerIconUrl(
  agentServer: string,
  agent: Pick<ACPRegistryAgent, "icon"> | null | undefined,
): string | undefined {
  if (agentServer === LOCAL_AGENT_SERVER) {
    return LOCAL_AGENT_ICON_URL;
  }
  // Draw the first-party Camber agent from our own roundel rather than the
  // registry's remote SVG, so its stroke weight stays under our control and
  // reads consistently beside the other agent icons instead of looking thin.
  if (agentServer === DEFAULT_AGENT_SERVER) {
    return CAMBER_ROUNDEL_ICON_URL;
  }
  return agent ? registryIconUrl(agent) : undefined;
}
