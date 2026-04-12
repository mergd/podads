declare module "mp3-parser" {
  export interface Mp3Section {
    type: string;
    offset: number;
    byteLength: number;
    sampleLength?: number;
    nextFrameIndex?: number;
  }

  export interface Mp3FrameHeader {
    bitrate: number;
    samplingRate: number;
    channelMode: string;
    frameIsPadded: boolean;
    framePadding: number;
  }

  export interface Mp3FrameDescription {
    _section: Mp3Section;
    header: Mp3FrameHeader;
  }

  export interface Mp3Id3v2TagDescription {
    _section: Mp3Section;
  }

  export interface Mp3XingTagDescription {
    _section: Mp3Section;
    identifier: string;
  }

  export interface Mp3ParserApi {
    readFrame(view: DataView, offset?: number, requireNextFrame?: boolean): Mp3FrameDescription | null;
    readId3v2Tag(view: DataView, offset?: number): Mp3Id3v2TagDescription | null;
    readXingTag(view: DataView, offset?: number): Mp3XingTagDescription | null;
  }

  const mp3Parser: Mp3ParserApi;
  export default mp3Parser;
}
