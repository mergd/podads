declare module "mp3-parser" {
  export interface Mp3FrameDescription {
    _section: {
      offset: number;
      byteLength: number;
      sampleLength?: number;
    };
    header: {
      samplingRate?: number;
    };
  }

  interface Id3TagDescription {
    _section: {
      byteLength: number;
    };
  }

  interface XingTagDescription {}

  const mp3Parser: {
    readFrame(view: DataView, offset: number, requireCrc?: boolean): Mp3FrameDescription | null;
    readId3v2Tag(view: DataView, offset: number): Id3TagDescription | null;
    readXingTag(view: DataView, offset: number): XingTagDescription | null;
  };

  export default mp3Parser;
}
