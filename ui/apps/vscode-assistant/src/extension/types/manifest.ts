import type { AllUnionFields, LiteralToPrimitive } from "type-fest";
import packageJson from "../../../package.json";

type Contributes = typeof packageJson.contributes;
type Properties = Contributes["configuration"]["properties"];
type Command = Contributes["commands"][number];

export type CamberCommand = Command["command"];
export type CamberWhenClause = NonNullable<AllUnionFields<Command>["enablement"]>;

export type CamberConfigurationProperty = keyof Properties;
export type CamberConfigurationProperties = {
  [K in CamberConfigurationProperty]: LiteralToPrimitive<Properties[K]["default"]>;
};

export type CamberContextKey = Extract<CamberWhenClause, `camber.${string}`>;

export type CamberContextKeys = {
  [K in CamberContextKey]: K extends `camber.can${string}` ? boolean : any;
};
