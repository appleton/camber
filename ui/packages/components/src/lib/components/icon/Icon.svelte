<script lang="ts" module>
  import { getContext, setContext, type Snippet } from "svelte";

  export interface IconContext {
    getFileIcon: (path: string, language?: string) => Promise<string | undefined>;
  }

  const KEY = Symbol("Icon");

  export function getIconContext() {
    return getContext<IconContext | undefined>(KEY);
  }

  export function setIconContext(context: IconContext) {
    return setContext(KEY, context);
  }
</script>

<script lang="ts">
  import type { IconName } from "./IconName.js";
  import { iconMap, iconVariantSupport } from "./icons.js";
  import { mergeProps } from "bits-ui";
  import type { WithChild } from "../../types/child.js";
  import { cn } from "@camber/tailwind-config/tv";

  interface BaseIconProps {
    size?: number;
  }

  interface ProductIconVariants {
    weight?: number;
    dashed?: boolean;
    gradient?: boolean;
  }

  export type ProductIconProps = BaseIconProps &
    ProductIconVariants & {
      type?: "product";
      name?: IconName;
    };

  export type FileIconProps = BaseIconProps & {
    type: "file";
    name?: string;
    language?: string;
    fallback?: IconName | false;
  };

  export type IconProps = WithChild<"span", { children: Snippet }> &
    (ProductIconProps | FileIconProps);

  let { type = "product", name, size, class: className, child, ...props }: IconProps = $props();
  let rest = $derived({ type, name, ...props } as IconProps);

  const context = getIconContext();

  const icon = $derived.by(() => {
    if (rest.type === "file") {
      if (!context || !rest.name) {
        if (rest.fallback === false) return;
        return {
          type: "product",
          Component: iconMap[rest.fallback ?? "file"],
        } as const;
      }

      return {
        type: "file",
        props: {
          path: rest.name,
          language: rest.language,
          fallback: rest.fallback,
        },
      } as const;
    }

    const { name = "plus" } = rest;
    const support = iconVariantSupport[name];
    return {
      type: "product",
      props: {
        weight: support.weight ? rest.weight : undefined,
        dashed: support.dashed ? (rest.dashed ?? false) : undefined,
        gradient: support.gradient ? (rest.gradient ?? false) : undefined,
      },
      Component: iconMap[name],
    } as const;
  });

  // Cache file icon SVG to prevent re-fetching on every render
  let fileIconSvg = $state<string | undefined | null>(null);
  let lastRequestedPath: string | null = null;

  $effect(() => {
    if (icon?.type === "file") {
      const { path, language } = icon.props;
      // Only fetch if path changed - prevents re-fetching on parent re-renders
      if (lastRequestedPath === path) return;
      lastRequestedPath = path;

      fileIconSvg = null;

      context
        ?.getFileIcon(path, language)
        .then((svg) => {
          // Only update if this is still the path we requested
          if (lastRequestedPath === path) {
            fileIconSvg = svg;
          }
        })
        .catch(() => {
          if (lastRequestedPath === path) {
            fileIconSvg = undefined;
          }
        });
    }
  });

  let mergedProps = $derived(
    mergeProps(props, {
      "data-type": icon ? icon.type : undefined,
      class: cn([
        "inline-block shrink-0 self-center [&>svg]:size-full",
        !size && "-mx-[0.05em] -my-[0.1em] size-[1.2em]",
        className,
      ]),
      style: size ? `width: ${size}px; height: ${size}px;` : "",
    }),
  );
</script>

{#snippet children()}
  {#if icon}
    {#if icon?.type === "product"}
      <icon.Component class="size-full" {size} {...icon.props} />
    {:else if fileIconSvg}
      {@html fileIconSvg}
    {:else if icon.props.fallback !== false}
      {@const Component = iconMap[icon.props.fallback ?? "file"]}
      <Component class="size-full" {size} />
    {/if}
  {/if}
{/snippet}

{#if child}
  {@render child({ props: mergedProps, children })}
{:else}
  <span {...mergedProps}>
    {@render children()}
  </span>
{/if}
