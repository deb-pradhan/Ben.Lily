import {
  AudioReceiveStream,
  NoSubscriberBehavior,
  StreamType,
  VoiceConnection,
  createAudioPlayer,
  createAudioResource,
  getVoiceConnection,
  joinVoiceChannel,
} from "@discordjs/voice";
import { UUID } from "crypto";
import {
  BaseGuildVoiceChannel,
  ChannelType,
  Client,
  Guild,
  GuildMember,
  VoiceChannel,
  VoiceState
} from "discord.js";
import fs from "fs";
import prism from "prism-media";
import { Readable, pipeline } from "stream";
import { default as getUuid } from "uuid-by-string";
import WavEncoder from "wav-encoder";
import { Agent } from "../../agent.ts";
import { SpeechSynthesizer } from "../../services/speechSynthesis.ts";
import { TranscriptionService } from "../../services/transcription.ts";
import settings from "../../settings.ts";
import { AudioMonitor } from "./audioMonitor.ts";
import { MessageManager } from "./messages.ts";

import { textToSpeech } from "../elevenlabs/index.ts";
import EventEmitter from "events";

// These values are chosen for compatibility with picovoice components
const DECODE_FRAME_SIZE = 1024;
const DECODE_SAMPLE_RATE = 16000;

export class VoiceManager extends EventEmitter {
  private client: Client;
  private agent: Agent;
  private streams: Map<string, Readable> = new Map();
  private connections: Map<string, VoiceConnection> = new Map();
  private speechSynthesizer: SpeechSynthesizer | null = null;
  transcriptionService: TranscriptionService;
  private messageManager: MessageManager;

  constructor(client: Client, agent: Agent, messageManager: MessageManager) {
    super()
    this.client = client;
    this.agent = agent;
    this.transcriptionService = new TranscriptionService();
    this.messageManager = messageManager;
  }

  async handleVoiceStateUpdate(oldState: VoiceState | null, newState: VoiceState | null) {
    if (newState?.member?.user.bot) return;
    if (newState?.channelId != null && newState?.channelId != oldState?.channelId) {
      this.joinChannel(newState.channel as BaseGuildVoiceChannel);
    }
  }

  async handleGuildCreate(guild: Guild) {
    console.log(`Joined guild ${guild.name}`);
    this.scanGuild(guild);
  }

  async handleUserStream(
    user_id: UUID,
    userName: string,
    channel: BaseGuildVoiceChannel,
    audioStream: Readable
  ) {
    const channelId = channel.id;

    const callback = async (responseAudioStream) => {
      await this.playAudioStream(user_id, responseAudioStream);
    }

    const buffers: Buffer[] = [];
    let totalLength = 0;
    const maxSilenceTime = 500; // Maximum pause duration in milliseconds
    let lastChunkTime = Date.now();
    
    const monitor = new AudioMonitor(audioStream, 10000000, async (buffer) => {
      const currentTime = Date.now();
      const silenceDuration = currentTime - lastChunkTime;

      buffers.push(buffer);
      totalLength += buffer.length;
      lastChunkTime = currentTime;

      if (silenceDuration > maxSilenceTime || totalLength >= 1000000) {
        const inputBuffer = Buffer.concat(buffers, totalLength);
        buffers.length = 0;
        totalLength = 0;

        try {
          const text = await this.transcriptionService.transcribe(inputBuffer);
          const room_id = getUuid(channelId) as UUID;
          const userIdUUID = getUuid(user_id) as UUID;
          const agentId = getUuid(settings.DISCORD_APPLICATION_ID as string) as UUID;

          // Note: You might need to adjust this line depending on how you're managing the discordClient reference
          const botName = await this.messageManager.fetchBotName(settings.DISCORD_API_TOKEN);

          await this.agent.ensureUserExists(agentId, botName);
          await this.agent.ensureUserExists(userIdUUID, userName);
          await this.agent.ensureRoomExists(room_id);
          await this.agent.ensureParticipantInRoom(userIdUUID, room_id);
          await this.agent.ensureParticipantInRoom(agentId, room_id);

          const state = await this.agent.runtime.composeState(
            { content: { content: text, action: "WAIT", source: "Discord" }, user_id: userIdUUID, room_id },
            {
              discordClient: this.client,
              agentName: botName,
            }
          );

          if (text && text.startsWith("/")) {
            return null;
          }

          const response = await this.messageManager.handleMessage({
            message: {
              content: { content: text, action: "WAIT" },
              user_id: userIdUUID,
              room_id,
            },
            callback: (str: any) => { },
            state
          });

          const content = (response.responseMessage ||
            response.content ||
            response.message) as string;

          if (!content) {
            return null;
          }

          let responseStream = await this.textToSpeech(content);

          if (responseStream) {
            callback(responseStream as Readable);
          }
        } catch (error) {
          console.error("Error processing audio stream:", error);
        }
      }
    });
  }

  async scanGuild(guild: Guild) {
    const channels = (await guild.channels.fetch()).filter(
      (channel) => channel?.type == ChannelType.GuildVoice,
    );
    let chosenChannel: BaseGuildVoiceChannel | null = null;

    for (const [, channel] of channels) {
      const voiceChannel = channel as BaseGuildVoiceChannel;
      if (
        voiceChannel.members.size > 0 &&
        (chosenChannel === null ||
          voiceChannel.members.size > chosenChannel.members.size)
      ) {
        chosenChannel = voiceChannel;
      }
    }

    if (chosenChannel != null) {
      this.joinChannel(chosenChannel);
    }
  }

  async joinChannel(channel: BaseGuildVoiceChannel) {
    const oldConnection = getVoiceConnection(channel.guildId as string);
    if (oldConnection) {
      try {
        oldConnection.destroy();
      } catch (error) {
        console.error("Error leaving voice channel:", error);
      }
    }
    const connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: false,
    });

    for (const [, member] of channel.members) {
      if (member.user.bot) continue;
      this.monitorMember(member, channel);
    }

    connection.receiver.speaking.on("start", (user_id: string) => {
      const user = channel.members.get(user_id);
      if (user?.user.bot) return;
      this.monitorMember(user as GuildMember, channel);
      this.streams.get(user_id)?.emit("speakingStarted");
    });

    connection.receiver.speaking.on("end", async (user_id: string) => {
      const user = channel.members.get(user_id);
      if (user?.user.bot) return;
      this.streams.get(user_id)?.emit("speakingStopped");
    });
  }

  private async monitorMember(
    member: GuildMember,
    channel: BaseGuildVoiceChannel,
  ) {
    const user_id = member.id;
    const userName = member.displayName;
    const connection = getVoiceConnection(member.guild.id);
    const receiveStream = connection?.receiver.subscribe(user_id, {
      autoDestroy: true,
      emitClose: true,
    });
    if (receiveStream && receiveStream.readableLength > 0) {
      return;
    }
    const opusDecoder = new prism.opus.Decoder({
      channels: 1,
      rate: DECODE_SAMPLE_RATE,
      frameSize: DECODE_FRAME_SIZE,
    });
    pipeline(
      receiveStream as AudioReceiveStream,
      opusDecoder as any,
      (err: Error | null) => {
        if (err) {
          console.log(`Opus decoding pipeline error: ${err}`);
        }
      },
    );
    this.streams.set(user_id, opusDecoder);
    this.connections.set(user_id, connection as VoiceConnection);
    opusDecoder.on("error", (err: any) => {
      console.log(`Opus decoding error: ${err}`);
    });
    const errorHandler = (err: any) => {
      console.log(`Opus decoding error: ${err}`);
    };
    const streamCloseHandler = () => {
      console.log(`voice stream from ${member?.displayName} closed`);
      this.streams.delete(user_id);
      this.connections.delete(user_id);
    };
    const closeHandler = () => {
      console.log(`Opus decoder for ${member?.displayName} closed`);
      opusDecoder.removeListener('error', errorHandler);
      opusDecoder.removeListener('close', closeHandler);
      receiveStream?.removeListener('close', streamCloseHandler);
    };
    opusDecoder.on("error", errorHandler);
    opusDecoder.on("close", closeHandler);
    receiveStream?.on("close", streamCloseHandler);

    this.client.emit("userStream", user_id, userName, channel, opusDecoder);
  }

  async playAudioStream(user_id: UUID, audioStream: Readable) {
    const connection = this.connections.get(user_id);
    if (connection == null) {
      console.log(`No connection for user ${user_id}`);
      return;
    }
    const audioPlayer = createAudioPlayer({
      behaviors: {
        noSubscriber: NoSubscriberBehavior.Pause,
      },
    });
    connection.subscribe(audioPlayer);

    const audioStartTime = Date.now();

    const resource = createAudioResource(audioStream, {
      inputType: StreamType.Arbitrary,
    });
    audioPlayer.play(resource);

    audioPlayer.on("error", (err: any) => {
      console.log(`Audio player error: ${err}`);
    });

    audioPlayer.on(
      "stateChange",
      (oldState: any, newState: { status: string }) => {
        if (newState.status == "idle") {
          const idleTime = Date.now();
          console.log(`Audio playback took: ${idleTime - audioStartTime}ms`);
        }
      },
    );
  }

  async handleJoinChannelCommand(interaction: any) {
    const channelId = interaction.options.get("channel")?.value as string;
    if (!channelId) {
      await interaction.reply("Please provide a voice channel to join.");
      return;
    }
    const guild = interaction.guild;
    if (!guild) {
      return;
    }
    const voiceChannel = interaction.guild.channels.cache.find(
      (channel: VoiceChannel) =>
        channel.id === channelId && channel.type === ChannelType.GuildVoice,
    );

    if (!voiceChannel) {
      await interaction.reply("Voice channel not found!");
      return;
    }

    try {
      this.joinChannel(voiceChannel as BaseGuildVoiceChannel);
      await interaction.reply(`Joined voice channel: ${voiceChannel.name}`);
    } catch (error) {
      console.error("Error joining voice channel:", error);
      await interaction.reply("Failed to join the voice channel.");
    }
  }

  async handleLeaveChannelCommand(interaction: any) {
    const connection = getVoiceConnection(interaction.guildId as any);

    if (!connection) {
      await interaction.reply("Not currently in a voice channel.");
      return;
    }

    try {
      connection.destroy();
      await interaction.reply("Left the voice channel.");
    } catch (error) {
      console.error("Error leaving voice channel:", error);
      await interaction.reply("Failed to leave the voice channel.");
    }
  }

  async textToSpeech(text: string): Promise<Readable> {
    // check for elevenlabs API key
    if (process.env.ELEVENLABS_XI_API_KEY) {
      return textToSpeech(text)
    }

    if (!this.speechSynthesizer) {
      this.speechSynthesizer = await SpeechSynthesizer.create("./model.onnx");
    }
    // Synthesize the speech to get a Float32Array of single channel 22050Hz audio data
    const audio = await this.speechSynthesizer.synthesize(text);

    // Encode the audio data into a WAV format
    const { encode } = WavEncoder;
    const audioData = {
      sampleRate: 22050,
      channelData: [audio],
    };
    const wavArrayBuffer = encode.sync(audioData);

    // TODO: Move to a temp file
    // Convert the ArrayBuffer to a Buffer and save it to a file
    fs.writeFileSync("buffer.wav", Buffer.from(wavArrayBuffer));

    // now read the file
    const wavStream = fs.createReadStream("buffer.wav");
    return wavStream;
  }
}