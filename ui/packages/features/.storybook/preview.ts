import { Providers } from "@camber/components/storybook";
import { definePreviewConfig } from "@camber/storybook-config";
import ACPContextDecorator from "./ACPContextDecorator.svelte";
import ElicitationDecorator from "./ElicitationDecorator.svelte";
import "./globals.css";

const preview = definePreviewConfig({
  decorators: [
    () => ({
      Component: ACPContextDecorator,
    }),
    (_, { parameters }) => ({
      Component: ElicitationDecorator,
      props: {
        pendingElicitationIds: parameters.elicitation?.pendingElicitationIds ?? [],
      },
    }),
    () => ({ Component: Providers }),
  ],
});

export default preview;
