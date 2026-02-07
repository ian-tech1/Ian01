{ pkgs }: {
  deps = [
    pkgs.nodejs-18_x
    pkgs.nodePackages.npm
    pkgs.ffmpeg
    pkgs.imagemagick
    pkgs.libwebp
  ];
}
