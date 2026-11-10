<script module lang="ts">
  import { defineMeta } from "@storybook/addon-svelte-csf";
  import Button, { button, type ButtonProps } from "./Button.svelte";
  import { fn, expect } from "storybook/test";
  import Icon from "../icon/Icon.svelte";
  import { sizes } from "../../utils/size.js";
  import { prominences } from "../../utils/prominence.js";

  const appearances = Object.keys(button.variants.appearance) as NonNullable<
    ButtonProps["appearance"]
  >[];
  const shapes = Object.keys(button.variants.shape) as NonNullable<ButtonProps["shape"]>[];
  const radii = Object.keys(button.variants.radius) as NonNullable<ButtonProps["radius"]>[];

  const { Story } = defineMeta({
    component: Button,
    args: {
      onclick: fn(),
      appearance: "default",
      disabled: false,
      shape: "rectangle",
      radius: "default",
    },
    render: template,
  });
</script>

{#snippet template(args: ButtonProps)}
  <Button {...args}>Button</Button>
{/snippet}

<Story
  name="Default"
  play={async ({ canvas, userEvent, args }) => {
    const button = canvas.getByRole("button");
    expect(button).toBeInTheDocument();
    await userEvent.click(button);
    expect(args.onclick).toHaveBeenCalled();
  }}
/>

<Story
  name="Appearance"
  argTypes={{
    appearance: { table: { disable: true } },
  }}
>
  {#snippet template(args)}
    <div class="flex items-center gap-2">
      {#each appearances as appearance}
        <Button {...args} {appearance}>{appearance}</Button>
      {/each}
    </div>
  {/snippet}
</Story>

<Story
  name="Prominence"
  argTypes={{
    prominence: { table: { disable: true } },
  }}
>
  {#snippet template(args)}
    <div class="flex items-center gap-2">
      {#each prominences as prominence}
        <Button {...args} {prominence}>{prominence}</Button>
      {/each}
    </div>
  {/snippet}
</Story>

<Story
  name="Disabled"
  args={{ disabled: true }}
  argTypes={{
    disabled: { table: { disable: true } },
  }}
  play={({ canvas }) => {
    const button = canvas.getByRole("button");
    expect(button).toBeDisabled();
  }}
/>

<Story
  name="Size"
  argTypes={{
    size: { table: { disable: true } },
  }}
>
  {#snippet template(args)}
    <div class="grid grid-cols-4 place-items-start gap-4">
      {#each sizes as size}
        <Button {...args} {size}>
          <Icon name="sparkles" />
          {size}
        </Button>
        <Button {...args} {size}>
          {size}
          <Icon name="arrow-right" />
        </Button>
        <Button {...args} {size}>
          <Icon name="admin" />
          {size}
          <Icon name="chevron" />
        </Button>
        <Button {...args} {size}>
          <Icon name="arrow-up-right" />
        </Button>
      {/each}
    </div>
  {/snippet}
</Story>

<Story
  name="Shape"
  argTypes={{
    shape: { table: { disable: true } },
  }}
>
  {#snippet template(args)}
    <div class="flex items-center gap-2">
      {#each shapes as shape}
        <Button {...args} {shape}>{shape}</Button>
      {/each}
    </div>
  {/snippet}
</Story>

<Story
  name="Radius"
  argTypes={{
    radius: { table: { disable: true } },
  }}
>
  {#snippet template(args)}
    <div class="flex items-center gap-2">
      {#each radii as radius}
        <Button {...args} {radius}>{radius}</Button>
      {/each}
    </div>
  {/snippet}
</Story>

<Story name="Bleed" args={{ appearance: "ghost" }}>
  {#snippet template(args)}
    <div class="flex gap-4">
      Text
      <Button {...args}>Button</Button>
    </div>
  {/snippet}
</Story>

<Story
  name="Child"
  play={({ canvas }) => {
    const link = canvas.getByRole("link");
    expect(link).toBeInTheDocument();
  }}
>
  {#snippet template(args)}
    <div class="flex items-start gap-2">
      <Button {...args}>
        {#snippet child({ props })}
          <a href="https://github.com/appleton/camber" {...props}>Link</a>
        {/snippet}
      </Button>
    </div>
  {/snippet}
</Story>
