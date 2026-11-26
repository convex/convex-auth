// troika-three-text has no type entry point. The world calls only this.
declare module "troika-three-text" {
  export function configureTextBuilder(config: { useWorker?: boolean }): void;
}
