import * as Chat2Gen from '../actions/chat2-gen'
import * as TeamBuildingGen from '../actions/team-building-gen'
import * as EngineGen from '../actions/engine-gen-gen'
import * as Constants from '../constants/chat2'
import * as Container from '../util/container'
import * as I from 'immutable'
import * as RPCChatTypes from '../constants/types/rpc-chat-gen'
import * as RPCTypes from '../constants/types/rpc-gen'
import * as Types from '../constants/types/chat2'
import teamBuildingReducer from './team-building'
import {isMobile} from '../constants/platform'
import logger from '../logger'
import HiddenString from '../util/hidden-string'
import partition from 'lodash/partition'
import shallowEqual from 'shallowequal'

type EngineActions =
  | EngineGen.Chat1NotifyChatChatTypingUpdatePayload
  | EngineGen.Chat1ChatUiChatBotCommandsUpdateStatusPayload
  | EngineGen.Chat1ChatUiChatInboxLayoutPayload

const initialState: Types.State = Constants.makeState()

// Backend gives us messageIDs sometimes so we need to find our ordinal
const messageIDToOrdinal = (
  messageMap: Container.Draft<Types.State['messageMap']>,
  pendingOutboxToOrdinal: Container.Draft<Types.State['pendingOutboxToOrdinal']>,
  conversationIDKey: Types.ConversationIDKey,
  messageID: Types.MessageID
) => {
  // A message we didn't send in this session?
  const mm = messageMap.get(conversationIDKey)
  let m = mm && mm.get(Types.numberToOrdinal(messageID))
  if (m && m.id && m.id === messageID) {
    return m.ordinal
  }
  // Search through our sent messages
  const pm = pendingOutboxToOrdinal.get(conversationIDKey)
  const pendingOrdinal =
    mm &&
    pm &&
    [...pm.values()].find(o => {
      m = mm.get(o)
      if (m && m.id && m.id === messageID) {
        return true
      }
      return false
    })

  if (pendingOrdinal) {
    return pendingOrdinal
  }

  return null
}

// update a message in a message map if the updater changes propagate up
const updateMessageInMessageMap = (
  messageMap: Map<Types.ConversationIDKey, Map<Types.Ordinal, Types.Message>>,
  conversationIDKey: Types.ConversationIDKey,
  ordinal: Types.Ordinal,
  updater: (m?: Types.Message) => undefined | Types.Message
) => {
  const ordToMsgMap = messageMap.get(conversationIDKey)
  const oldMsg = (ordToMsgMap && ordToMsgMap.get(ordinal)) || undefined
  const newMsg = updater(oldMsg)
  if (oldMsg === newMsg) {
    return messageMap
  } else {
    const newOrdToMsgMap = new Map(ordToMsgMap || [])
    if (newMsg) {
      newOrdToMsgMap.set(ordinal, newMsg)
    } else {
      newOrdToMsgMap.delete(ordinal)
    }
    const newMessageMap = new Map(messageMap)
    newMessageMap.set(conversationIDKey, newOrdToMsgMap)
    return newMessageMap
  }
}

const metaMapReducer = (
  metaMap: Container.Draft<Types.State['metaMap']>,
  action: Chat2Gen.Actions
): Container.Draft<Types.State['metaMap']> => {
  switch (action.type) {
    case Chat2Gen.setConversationOffline: {
      const {conversationIDKey, offline} = action.payload
      const old = metaMap.get(conversationIDKey)
      if (old) {
        const mm = new Map(metaMap)
        mm.set(conversationIDKey, {
          ...old,
          offline,
        })
        return mm
      }
      return metaMap
    }
    case Chat2Gen.metaDelete: {
      const {conversationIDKey} = action.payload
      const mm = new Map(metaMap)
      mm.delete(conversationIDKey)
      return mm
    }
    case Chat2Gen.notificationSettingsUpdated: {
      const {conversationIDKey, settings} = action.payload
      const old = metaMap.get(conversationIDKey)
      if (old) {
        const mm = new Map(metaMap)
        mm.set(conversationIDKey, Constants.updateMetaWithNotificationSettings(old, settings))
        return mm
      }
      return metaMap
    }
    case Chat2Gen.metaRequestingTrusted: {
      const {conversationIDKeys} = action.payload
      const mm = new Map(metaMap)
      const ids = Constants.getConversationIDKeyMetasToLoad(
        conversationIDKeys,
        metaMap as Types.State['metaMap']
      )
      ids.forEach(conversationIDKey => {
        const old = mm.get(conversationIDKey)
        if (old) {
          mm.set(conversationIDKey, {...old, trustedState: 'requesting'})
        }
      })
      return mm
    }
    case Chat2Gen.metaReceivedError: {
      const {error, username, conversationIDKey} = action.payload
      if (error) {
        switch (error.typ) {
          case RPCChatTypes.ConversationErrorType.otherrekeyneeded: // fallthrough
          case RPCChatTypes.ConversationErrorType.selfrekeyneeded: {
            const rekeyInfo = error.rekeyInfo
            const participants = [
              ...(rekeyInfo
                ? new Set<string>(
                    ([] as Array<string>)
                      .concat(rekeyInfo.writerNames || [], rekeyInfo.readerNames || [])
                      .filter(Boolean)
                  )
                : new Set<string>(error.unverifiedTLFName.split(','))),
            ]

            const rekeyers = new Set<string>(
              error.typ === RPCChatTypes.ConversationErrorType.selfrekeyneeded
                ? [username || '']
                : (error.rekeyInfo && error.rekeyInfo.rekeyers) || []
            )
            const newMeta = Constants.unverifiedInboxUIItemToConversationMeta(error.remoteConv)
            if (!newMeta) {
              // public conversation, do nothing
              return metaMap
            }
            const mm = new Map(metaMap)
            mm.set(conversationIDKey, {
              ...newMeta,
              participants,
              rekeyers,
              snippet: error.message,
              snippetDecoration: '',
              trustedState: 'error' as const,
            })
            return mm
          }
          default: {
            const old = metaMap.get(conversationIDKey)
            if (old) {
              const mm = new Map(metaMap)
              mm.set(conversationIDKey, {
                ...old,
                snippet: error.message,
                snippetDecoration: '',
                trustedState: 'error',
              })
              return mm
            }
            return metaMap
          }
        }
      } else {
        const mm = new Map(metaMap)
        mm.delete(action.payload.conversationIDKey)
        return mm
      }
    }
    case Chat2Gen.clearMetas:
      return new Map()
    case Chat2Gen.metasReceived: {
      const mm = new Map(metaMap)
      const {removals, metas} = action.payload
      ;(removals || []).forEach(m => mm.delete(m))
      metas.forEach(m => {
        const old = mm.get(m.conversationIDKey)
        mm.set(m.conversationIDKey, old ? Constants.updateMeta(old, m) : m)
      })
      return mm
    }
    case Chat2Gen.updateConvRetentionPolicy: {
      const {meta} = action.payload
      const newMeta = meta
      if (metaMap.has(newMeta.conversationIDKey)) {
        // only insert if the convo is already in the inbox
        return metaMap.set(newMeta.conversationIDKey, newMeta)
      }
      return metaMap
    }
    case Chat2Gen.updateTeamRetentionPolicy: {
      const {metas} = action.payload
      const mm = new Map(metaMap)
      metas.forEach(meta => {
        if (meta && metaMap.has(meta.conversationIDKey)) {
          // only insert if the convo is already in the inbox
          mm.set(meta.conversationIDKey, meta)
        }
      })
      return mm
    }
    case Chat2Gen.saveMinWriterRole: {
      const {cannotWrite, conversationIDKey, role} = action.payload
      const old = metaMap.get(conversationIDKey)
      if (!old) {
        return metaMap
      }
      const mm = new Map(metaMap)
      mm.set(conversationIDKey, {
        ...old,
        cannotWrite,
        minWriterRole: role,
      })
      return mm
    }
    default:
      return metaMap
  }
}

const messageMapReducer = (
  messageMap: Container.Draft<Types.State['messageMap']>,
  action: Chat2Gen.Actions,
  pendingOutboxToOrdinal: Container.Draft<Types.State['pendingOutboxToOrdinal']>
) => {
  switch (action.type) {
    case Chat2Gen.markConversationsStale: {
      const {conversationIDKeys, updateType} = action.payload
      if (updateType !== RPCChatTypes.StaleUpdateType.clear) {
        return messageMap
      }
      const mm = new Map(messageMap)
      conversationIDKeys.forEach(k => mm.delete(k))
      return mm
    }
    case Chat2Gen.messageEdit: // fallthrough
    case Chat2Gen.messageDelete: {
      const {conversationIDKey, ordinal} = action.payload
      const submitState = action.type === Chat2Gen.messageDelete ? 'deleting' : 'editing'
      return updateMessageInMessageMap(messageMap, conversationIDKey, ordinal, m =>
        m && m.type === 'text' ? {...m, submitState} : m
      )
    }
    case Chat2Gen.messageAttachmentUploaded: {
      const {conversationIDKey, message, placeholderID} = action.payload
      const ordinal = messageIDToOrdinal(messageMap, pendingOutboxToOrdinal, conversationIDKey, placeholderID)
      return ordinal
        ? updateMessageInMessageMap(messageMap, conversationIDKey, ordinal, m =>
            m ? Constants.upgradeMessage(m, message) : m
          )
        : messageMap
    }
    case Chat2Gen.messageWasEdited: {
      const {conversationIDKey, messageID, text} = action.payload
      const {mentionsAt, mentionsChannel, mentionsChannelName} = action.payload
      const ordinal = messageIDToOrdinal(messageMap, pendingOutboxToOrdinal, conversationIDKey, messageID)
      if (!ordinal) return messageMap

      return updateMessageInMessageMap(messageMap, conversationIDKey, ordinal, m => {
        if (!m || m.type !== 'text') {
          return m
        } else {
          return {
            ...m,
            hasBeenEdited: true,
            mentionsAt,
            mentionsChannel,
            mentionsChannelName,
            submitState: null,
            text,
          }
        }
      })
    }
    case Chat2Gen.pendingMessageWasEdited: {
      const {conversationIDKey, ordinal, text} = action.payload
      return updateMessageInMessageMap(messageMap, conversationIDKey, ordinal, m =>
        !m || m.type !== 'text' ? m : {...m, text}
      )
    }
    case Chat2Gen.attachmentUploading: {
      const {conversationIDKey, outboxID, ratio} = action.payload
      const convMap = pendingOutboxToOrdinal.get(conversationIDKey)
      const ordinal = convMap && convMap.get(outboxID)
      if (!ordinal) return messageMap

      return updateMessageInMessageMap(messageMap, conversationIDKey, ordinal, m =>
        !m || m.type !== 'attachment' ? m : {...m, transferProgress: ratio, transferState: 'uploading'}
      )
    }
    case Chat2Gen.attachmentLoading: {
      const {message, conversationIDKey, isPreview, ratio} = action.payload
      const {ordinal} = message

      return updateMessageInMessageMap(messageMap, conversationIDKey, ordinal, m => {
        if (!m || m.type !== 'attachment') {
          return m
        }
        return isPreview
          ? {...m, previewTransferState: 'downloading'}
          : {
              ...m,
              transferErrMsg: null,
              transferProgress: ratio,
              transferState: 'downloading',
            }
      })
    }
    case Chat2Gen.attachmentUploaded: {
      const {conversationIDKey, ordinal} = action.payload
      return updateMessageInMessageMap(messageMap, conversationIDKey, ordinal, m =>
        !m || m.type !== 'attachment' ? m : {...m, transferProgress: 0, transferState: null}
      )
    }
    case Chat2Gen.attachmentMobileSave: {
      const {conversationIDKey, ordinal} = action.payload
      return updateMessageInMessageMap(messageMap, conversationIDKey, ordinal, m =>
        !m || m.type !== 'attachment' ? m : {...m, transferErrMsg: null, transferState: 'mobileSaving'}
      )
    }
    case Chat2Gen.attachmentMobileSaved: {
      const {conversationIDKey, ordinal} = action.payload
      return updateMessageInMessageMap(messageMap, conversationIDKey, ordinal, m =>
        !m || m.type !== 'attachment' ? m : {...m, transferErrMsg: null, transferState: null}
      )
    }
    case Chat2Gen.attachmentDownload: {
      const {message} = action.payload
      const {conversationIDKey, ordinal} = message
      return updateMessageInMessageMap(messageMap, conversationIDKey, ordinal, m =>
        !m || m.type !== 'attachment' ? m : {...m, transferErrMsg: null, transferState: 'downloading'}
      )
    }
    case Chat2Gen.attachmentDownloaded: {
      const {message, error, path} = action.payload
      const {conversationIDKey, ordinal} = message
      const downloadPath = (!error && path) || ''
      return updateMessageInMessageMap(messageMap, conversationIDKey, ordinal, m =>
        !m || m.type !== 'attachment'
          ? m
          : {
              ...m,
              downloadPath,
              fileURLCached: true, // assume we have this on the service now
              transferErrMsg: error ? error || 'Error downloading attachment' : null,
              transferProgress: 0,
              transferState: null,
            }
      )
    }
    case Chat2Gen.clearMessages:
      return new Map()
    case Chat2Gen.updateMessages: {
      const {messages, conversationIDKey} = action.payload
      const updateOrdinals = messages.reduce<Array<{msg: Types.Message; ordinal: Types.Ordinal}>>(
        (arr, m) => {
          const ordinal = messageIDToOrdinal(
            messageMap,
            pendingOutboxToOrdinal,
            action.payload.conversationIDKey,
            m.messageID
          )
          if (ordinal) {
            const msg = {...m.message, ordinal}
            arr.push({msg, ordinal})
          }
          return arr
        },
        []
      )
      const mm = new Map(messageMap)
      const ordToMsg = new Map(mm.get(conversationIDKey) || [])
      updateOrdinals.forEach(({msg, ordinal}) => ordToMsg.set(ordinal, msg))
      mm.set(conversationIDKey, ordToMsg)
      return mm
    }
    case Chat2Gen.messagesExploded: {
      const {conversationIDKey, messageIDs, explodedBy} = action.payload
      logger.info(`messagesExploded: exploding ${messageIDs.length} messages`)
      const ordinals = messageIDs.reduce<Array<Types.Ordinal>>((arr, mid) => {
        const ord = messageIDToOrdinal(messageMap, pendingOutboxToOrdinal, conversationIDKey, mid)
        ord && arr.push(ord)
        return arr
      }, [])
      if (ordinals.length === 0) {
        // found nothing
        return messageMap
      }
      const mm = new Map(messageMap)
      const ordToMsg = new Map(mm.get(conversationIDKey) || [])
      ordinals.forEach(ordinal => {
        const old = ordToMsg.get(ordinal)
        if (!old) return
        ordToMsg.set(ordinal, {
          ...old,
          exploded: true,
          explodedBy: explodedBy || '',
          flipGameID: '',
          mentionsAt: undefined,
          reactions: undefined,
          text: new HiddenString(''),
          unfurls: undefined,
        })
      })
      mm.set(conversationIDKey, ordToMsg)
      return mm
    }
    default:
      return messageMap
  }
}

const messageOrdinalsReducer = (
  messageOrdinals: Container.Draft<Types.State['messageOrdinals']>,
  action: Chat2Gen.Actions
): Container.Draft<Types.State['messageOrdinals']> => {
  switch (action.type) {
    case Chat2Gen.markConversationsStale:
      if (action.payload.updateType === RPCChatTypes.StaleUpdateType.clear) {
        const m = new Map(messageOrdinals)
        action.payload.conversationIDKeys.forEach(k => m.delete(k))
        return m
      } else {
        return messageOrdinals
      }
    case Chat2Gen.clearMessages:
      return new Map()
    default:
      return messageOrdinals
  }
}

const badgeKey = String(isMobile ? RPCTypes.DeviceType.mobile : RPCTypes.DeviceType.desktop)

type Actions = Chat2Gen.Actions | TeamBuildingGen.Actions | EngineActions

export default (_state: Types.State = initialState, action: Actions): Types.State =>
  Container.produce(_state, (draftState: Container.Draft<Types.State>) => {
    switch (action.type) {
      case Chat2Gen.resetStore:
        return {...initialState, staticConfig: draftState.staticConfig as Types.State['staticConfig']}
      case Chat2Gen.setInboxShowIsNew:
        draftState.inboxShowNew = action.payload.isNew
        return
      case Chat2Gen.toggleSmallTeamsExpanded:
        draftState.smallTeamsExpanded = !draftState.smallTeamsExpanded
        return
      case Chat2Gen.changeFocus:
        draftState.focus = action.payload.nextFocus
        return
      case Chat2Gen.setChannelSearchText:
        draftState.channelSearchText = action.payload.text.toLowerCase()
        return
      case Chat2Gen.selectConversation:
        {
          // ignore non-changing
          if (draftState.selectedConversation === action.payload.conversationIDKey) {
            return
          }

          const conversationIDKey = action.payload.conversationIDKey
          if (conversationIDKey) {
            const {readMsgID, maxVisibleMsgID} =
              draftState.metaMap.get(conversationIDKey) || Constants.makeConversationMeta()

            logger.info(
              `rootReducer: selectConversation: setting orange line: convID: ${conversationIDKey} maxVisible: ${maxVisibleMsgID} read: ${readMsgID}`
            )
            const orangeLineMap = new Map(draftState.orangeLineMap)
            if (maxVisibleMsgID > readMsgID) {
              // Store the message ID that will display the orange line above it,
              // which is the first message after the last read message. We can't
              // just increment `readMsgID` since that msgID might be a
              // non-visible (edit, delete, reaction...) message so we scan the
              // ordinals for the appropriate value.
              const messageMap = draftState.messageMap.get(
                conversationIDKey,
                I.Map<Types.Ordinal, Types.Message>()
              )
              const ordinals =
                draftState.messageOrdinals.get(conversationIDKey) || I.OrderedSet<Types.Ordinal>()
              const ord = ordinals.find(o => {
                const message = messageMap.get(o)
                return !!(message && message.id >= readMsgID + 1)
              })
              const message = ord && messageMap.get(ord)
              if (message && message.id) {
                orangeLineMap.set(conversationIDKey, message.id)
              } else {
                orangeLineMap.delete(conversationIDKey)
              }
            } else {
              // If there aren't any new messages, we don't want to display an
              // orange line so remove its entry from orangeLineMap
              orangeLineMap.delete(conversationIDKey)
            }
            draftState.orangeLineMap = orangeLineMap
          }
          const prevConvIDKey = draftState.selectedConversation
          // blank out draft so we don't flash old data when switching convs
          const meta = draftState.metaMap.get(prevConvIDKey)
          if (meta) {
            const metaMap = new Map(draftState.metaMap)
            metaMap.set(prevConvIDKey, {...meta, draft: ''})
            draftState.metaMap = metaMap
          }
          const messageCenterOrdinals = new Map(draftState.messageCenterOrdinals)
          messageCenterOrdinals.delete(conversationIDKey)
          draftState.messageCenterOrdinals = messageCenterOrdinals
          const threadLoadStatus = new Map(draftState.threadLoadStatus)
          threadLoadStatus.delete(conversationIDKey)
          draftState.threadLoadStatus = threadLoadStatus

          const containsLatestMessageMap = new Map(draftState.containsLatestMessageMap)
          containsLatestMessageMap.set(conversationIDKey, true)
          draftState.containsLatestMessageMap = containsLatestMessageMap
          draftState.previousSelectedConversation = prevConvIDKey
          draftState.selectedConversation = conversationIDKey
          if (Constants.isValidConversationIDKey(conversationIDKey)) {
            // If navigating away from error conversation to a valid conv - clear
            // error msg.
            draftState.createConversationError = null
          }
        }
        return
      case Chat2Gen.conversationErrored:
        draftState.createConversationError = action.payload.message
        return
      case Chat2Gen.updateUnreadline: {
        const orangeLineMap = new Map(draftState.orangeLineMap)
        if (action.payload.messageID > 0) {
          orangeLineMap.set(action.payload.conversationIDKey, action.payload.messageID)
        } else {
          orangeLineMap.delete(action.payload.conversationIDKey)
        }
        draftState.orangeLineMap = orangeLineMap
        return
      }
      case Chat2Gen.unfurlTogglePrompt: {
        const {show, domain, conversationIDKey, messageID} = action.payload
        const unfurlPromptMap = new Map(draftState.unfurlPromptMap || [])
        const mmap = new Map(unfurlPromptMap.get(conversationIDKey) || [])
        const prompts = new Set(mmap.get(messageID) || [])
        if (show) {
          prompts.add(domain)
        } else {
          prompts.delete(domain)
        }
        mmap.set(messageID, prompts)
        unfurlPromptMap.set(conversationIDKey, mmap)
        draftState.unfurlPromptMap = unfurlPromptMap
        return
      }
      case Chat2Gen.updateCoinFlipStatus: {
        const flipStatusMap = draftState.flipStatusMap
        action.payload.statuses.forEach(status => {
          flipStatusMap.set(status.gameID, status)
        })
        draftState.flipStatusMap = flipStatusMap
        return
      }
      case Chat2Gen.messageSend: {
        const commandMarkdownMap = new Map(draftState.commandMarkdownMap)
        commandMarkdownMap.delete(action.payload.conversationIDKey)
        draftState.commandMarkdownMap = commandMarkdownMap
        const replyToMap = new Map(draftState.replyToMap)
        replyToMap.delete(action.payload.conversationIDKey)
        draftState.replyToMap = replyToMap
        return
      }
      case Chat2Gen.setCommandMarkdown: {
        const {conversationIDKey, md} = action.payload
        const commandMarkdownMap = new Map(draftState.commandMarkdownMap)
        if (md) {
          commandMarkdownMap.set(conversationIDKey, md)
        } else {
          commandMarkdownMap.delete(conversationIDKey)
        }
        draftState.commandMarkdownMap = commandMarkdownMap
        return
      }
      case Chat2Gen.setThreadLoadStatus: {
        const threadLoadStatus = new Map(draftState.threadLoadStatus)
        threadLoadStatus.set(action.payload.conversationIDKey, action.payload.status)
        draftState.threadLoadStatus = threadLoadStatus
        return
      }
      case Chat2Gen.setCommandStatusInfo: {
        const commandStatusMap = new Map(draftState.commandStatusMap)
        commandStatusMap.set(action.payload.conversationIDKey, action.payload.info)
        draftState.commandStatusMap = commandStatusMap
        return
      }
      case Chat2Gen.clearCommandStatusInfo: {
        const {conversationIDKey} = action.payload
        const commandStatusMap = new Map(draftState.commandStatusMap)
        commandStatusMap.delete(conversationIDKey)
        draftState.commandStatusMap = commandStatusMap
        return
      }
      case Chat2Gen.giphyToggleWindow: {
        const conversationIDKey = action.payload.conversationIDKey

        const giphyWindowMap = new Map(draftState.giphyWindowMap)
        giphyWindowMap.set(conversationIDKey, action.payload.show)
        draftState.giphyWindowMap = giphyWindowMap
        if (!action.payload.show) {
          const giphyResultMap = new Map(draftState.giphyResultMap)
          giphyResultMap.set(conversationIDKey, undefined)
          draftState.giphyResultMap = giphyResultMap
        }
        if (action.payload.clearInput) {
          const unsentTextMap = new Map(draftState.unsentTextMap)
          unsentTextMap.set(action.payload.conversationIDKey, new HiddenString(''))
          draftState.unsentTextMap = unsentTextMap
        }
        return
      }
      case Chat2Gen.updateLastCoord:
        draftState.lastCoord = action.payload.coord
        return
      case Chat2Gen.giphyGotSearchResult: {
        const giphyResultMap = new Map(draftState.giphyResultMap)
        giphyResultMap.set(action.payload.conversationIDKey, action.payload.results)
        draftState.giphyResultMap = giphyResultMap
        return
      }
      case Chat2Gen.setPaymentConfirmInfo:
        draftState.paymentConfirmInfo = action.payload.error
          ? {error: action.payload.error}
          : {summary: action.payload.summary}
        return
      case Chat2Gen.clearPaymentConfirmInfo:
        draftState.paymentConfirmInfo = undefined
        return
      case Chat2Gen.badgesUpdated: {
        const badgeMap = new Map<Types.ConversationIDKey, number>(
          action.payload.conversations.map(({convID, badgeCounts}) => [
            Types.conversationIDToKey(convID),
            badgeCounts[badgeKey] || 0,
          ])
        )
        if (!shallowEqual([...badgeMap.entries()], [...draftState.badgeMap.entries()])) {
          draftState.badgeMap = badgeMap
        }
        const unreadMap = new Map<Types.ConversationIDKey, number>(
          action.payload.conversations.map(({convID, unreadMessages}) => [
            Types.conversationIDToKey(convID),
            unreadMessages,
          ])
        )

        if (!shallowEqual([...unreadMap.entries()], [...draftState.unreadMap.entries()])) {
          draftState.unreadMap = unreadMap
        }

        return
      }
      case Chat2Gen.messageSetEditing: {
        const {conversationIDKey, editLastUser, ordinal} = action.payload

        // clearing
        if (!editLastUser && !ordinal) {
          const editingMap = new Map(draftState.editingMap)
          editingMap.delete(conversationIDKey)
          draftState.editingMap = editingMap
          return
        }

        const messageMap = draftState.messageMap.get(conversationIDKey, I.Map<Types.Ordinal, Types.Message>())

        // editing a specific message
        if (ordinal) {
          const message = messageMap.get(ordinal)
          if (message && message.type === 'text') {
            const editingMap = new Map(draftState.editingMap)
            editingMap.set(conversationIDKey, ordinal)
            draftState.editingMap = editingMap
            return
          } else {
            return
          }
        }

        // Editing your last message
        const ordinals = draftState.messageOrdinals.get(conversationIDKey) || I.OrderedSet<Types.Ordinal>()
        const found = ordinals.findLast(o => {
          const message = messageMap.get(o)
          return !!(
            message &&
            message.type === 'text' &&
            message.author === editLastUser &&
            !message.exploded &&
            message.isEditable
          )
        })
        if (found) {
          const editingMap = new Map(draftState.editingMap)
          editingMap.set(conversationIDKey, found)
          draftState.editingMap = editingMap
          return
        }
        return
      }
      case Chat2Gen.messageSetQuoting: {
        const {ordinal, sourceConversationIDKey, targetConversationIDKey} = action.payload
        const counter = (draftState.quote ? draftState.quote.counter : 0) + 1
        draftState.quote = {
          counter,
          ordinal,
          sourceConversationIDKey,
          targetConversationIDKey,
        }
        return
      }
      case Chat2Gen.messagesAdd: {
        const {context, shouldClearOthers} = action.payload
        // pull out deletes and handle at the end
        const [messages, deletedMessages] = partition(action.payload.messages, m => m.type !== 'deleted')
        // we want the clear applied when we call findExisting
        let oldMessageOrdinals = draftState.messageOrdinals
        let oldPendingOutboxToOrdinal = draftState.pendingOutboxToOrdinal
        let oldMessageMap = draftState.messageMap

        // so we can keep messages if they haven't mutated
        const previousMessageMap = draftState.messageMap

        // first group into convoid
        const convoToMessages: {[K in string]: Array<Types.Message>} = messages.reduce((map: any, m) => {
          const key = String(m.conversationIDKey)
          map[key] = map[key] || []
          map[key].push(m)
          return map
        }, {})
        const convoToDeletedOrdinals: {[K in string]: Set<Types.Ordinal>} = deletedMessages.reduce(
          (map: any, m) => {
            const key = String(m.conversationIDKey)
            // @ts-ignore
            map[key] = map[key] || new Set()
            // @ts-ignore
            map[key].add(m.ordinal)
            return map
          },
          {}
        )

        if (shouldClearOthers) {
          oldMessageOrdinals = oldMessageOrdinals.withMutations(map => {
            Object.keys(convoToMessages).forEach(cid => map.delete(Types.stringToConversationIDKey(cid)))
          })
          oldPendingOutboxToOrdinal = oldPendingOutboxToOrdinal.withMutations(map => {
            Object.keys(convoToMessages).forEach(cid => map.delete(Types.stringToConversationIDKey(cid)))
          })
          oldMessageMap = oldMessageMap.withMutations(map => {
            Object.keys(convoToMessages).forEach(cid => map.delete(Types.stringToConversationIDKey(cid)))
          })
        }

        // Types we can send and have to deal with outbox ids
        const canSendType = (m: Types.Message): Types.MessageText | null | Types.MessageAttachment | null =>
          m.type === 'text' || m.type === 'attachment' ? m : null

        // Update any pending messages
        const pendingOutboxToOrdinal = oldPendingOutboxToOrdinal.withMutations(
          (map: I.Map<Types.ConversationIDKey, I.Map<Types.OutboxID, Types.Ordinal>>) => {
            if (context.type === 'sent' || context.type === 'threadLoad' || context.type === 'incoming') {
              messages.forEach(message => {
                const m = canSendType(message)
                if (m && !m.id && m.outboxID) {
                  map.setIn([m.conversationIDKey, m.outboxID], m.ordinal)
                }
              })
            }
          }
        )

        const findExistingSentOrPending = (
          conversationIDKey: Types.ConversationIDKey,
          m: Types.MessageText | Types.MessageAttachment
        ) => {
          // something we sent
          if (m.outboxID) {
            // and we know about it
            const ordinal = oldPendingOutboxToOrdinal.getIn([conversationIDKey, m.outboxID])
            if (ordinal) {
              return oldMessageMap.getIn([conversationIDKey, ordinal])
            }
          }
          const pendingOrdinal = messageIDToOrdinal(
            oldMessageMap,
            oldPendingOutboxToOrdinal,
            conversationIDKey,
            m.id
          )
          if (pendingOrdinal) {
            return oldMessageMap.getIn([conversationIDKey, pendingOrdinal])
          }
          return null
        }

        let messageOrdinals = oldMessageOrdinals.withMutations(
          (map: I.Map<Types.ConversationIDKey, I.OrderedSet<Types.Ordinal>>) => {
            Object.keys(convoToDeletedOrdinals).forEach(cid => {
              const conversationIDKey = Types.stringToConversationIDKey(cid)
              map.update(conversationIDKey, I.OrderedSet(), (set: I.OrderedSet<Types.Ordinal>) =>
                set.subtract(convoToDeletedOrdinals[conversationIDKey])
              )
            })
          }
        )
        messageOrdinals = messageOrdinals.withMutations(
          (map: I.Map<Types.ConversationIDKey, I.OrderedSet<Types.Ordinal>>) => {
            Object.keys(convoToMessages).forEach(cid => {
              const conversationIDKey = Types.stringToConversationIDKey(cid)
              const messages = convoToMessages[cid]
              const removedOrdinals: Array<Types.Ordinal> = []
              const ordinals = messages.reduce<Array<Types.Ordinal>>((arr, message) => {
                const m = canSendType(message)
                if (m) {
                  // Sendable so we might have an existing message
                  if (!findExistingSentOrPending(conversationIDKey, m)) {
                    arr.push(m.ordinal)
                  }
                  // We might have a placeholder for this message in there with ordinal of its own ID, let's
                  // get rid of it if that is the case
                  if (m.id) {
                    const oldMsg: Types.Message = oldMessageMap.getIn([
                      conversationIDKey,
                      Types.numberToOrdinal(m.id),
                    ])
                    if (oldMsg && oldMsg.type === 'placeholder' && oldMsg.ordinal !== m.ordinal) {
                      removedOrdinals.push(oldMsg.ordinal)
                    }
                  }
                } else if (message.type === 'placeholder') {
                  // sometimes we send then get a placeholder for that send. Lets see if we already have the message id for the sent
                  // and ignore the placeholder in that instance
                  logger.info(`Got placeholder message with id: ${message.id}`)
                  const existingOrdinal = messageIDToOrdinal(
                    oldMessageMap,
                    pendingOutboxToOrdinal,
                    conversationIDKey,
                    message.id
                  )
                  if (!existingOrdinal) {
                    arr.push(message.ordinal)
                  } else {
                    logger.info(
                      `Skipping placeholder for message with id ${message.id} because already exists`
                    )
                  }
                } else {
                  arr.push(message.ordinal)
                }
                return arr
              }, [])

              map.update(conversationIDKey, I.OrderedSet(), (set: I.OrderedSet<Types.Ordinal>) =>
                // add new ones, remove deleted ones, sort
                set
                  .subtract(removedOrdinals)
                  .concat(ordinals)
                  .sort()
              )
            })
          }
        )

        let messageMap = oldMessageMap.withMutations(
          (map: I.Map<Types.ConversationIDKey, I.Map<Types.Ordinal, Types.Message>>) => {
            Object.keys(convoToDeletedOrdinals).forEach(cid => {
              const conversationIDKey = Types.stringToConversationIDKey(cid)
              map.update(conversationIDKey, (m = I.Map()) =>
                m.deleteAll(convoToDeletedOrdinals[conversationIDKey])
              )
            })
          }
        )
        messageMap = messageMap.withMutations(
          (map: I.Map<Types.ConversationIDKey, I.Map<Types.Ordinal, Types.Message>>) => {
            Object.keys(convoToMessages).forEach(cid => {
              const conversationIDKey = Types.stringToConversationIDKey(cid)
              const messages = convoToMessages[cid]
              messages.forEach(message => {
                const m = canSendType(message)
                const oldSentOrPending = m ? findExistingSentOrPending(conversationIDKey, m) : null
                let toSet
                if (oldSentOrPending) {
                  toSet = Constants.upgradeMessage(oldSentOrPending, message)
                } else {
                  toSet = Constants.mergeMessage(
                    m ? previousMessageMap.getIn([conversationIDKey, m.ordinal]) : null,
                    message
                  )
                }
                map.setIn([conversationIDKey, toSet.ordinal], toSet)
              })
            })
          }
        )

        const containsLatestMessageMap = new Map(draftState.containsLatestMessageMap)
        Object.keys(convoToMessages).forEach(cid => {
          const conversationIDKey = Types.stringToConversationIDKey(cid)
          if (!action.payload.forceContainsLatestCalc && containsLatestMessageMap.get(conversationIDKey)) {
            return
          }
          const meta = draftState.metaMap.get(conversationIDKey)
          const ordinals = messageOrdinals.get(conversationIDKey, I.OrderedSet()).toArray()
          let maxMsgID = 0
          const convMsgMap = messageMap.get(conversationIDKey, I.Map<Types.Ordinal, Types.Message>())
          for (let i = ordinals.length - 1; i >= 0; i--) {
            const ordinal = ordinals[i]
            const message = convMsgMap.get(ordinal)
            if (message && message.id > 0) {
              maxMsgID = message.id
              break
            }
          }
          if (meta && maxMsgID >= meta.maxVisibleMsgID) {
            containsLatestMessageMap.set(conversationIDKey, true)
          } else if (action.payload.forceContainsLatestCalc) {
            containsLatestMessageMap.set(conversationIDKey, false)
          }
        })
        draftState.containsLatestMessageMap = containsLatestMessageMap

        let messageCenterOrdinals = draftState.messageCenterOrdinals
        const centeredMessageIDs = action.payload.centeredMessageIDs || []
        centeredMessageIDs.forEach(cm => {
          let ordinal = messageIDToOrdinal(
            draftState.messageMap,
            draftState.pendingOutboxToOrdinal,
            cm.conversationIDKey,
            cm.messageID
          )
          if (!ordinal) {
            ordinal = Types.numberToOrdinal(Types.messageIDToNumber(cm.messageID))
          }
          messageCenterOrdinals = messageCenterOrdinals.set(cm.conversationIDKey, {
            highlightMode: cm.highlightMode,
            ordinal,
          })
        })

        draftState.messageMap = messageMap
        if (centeredMessageIDs.length > 0) {
          draftState.messageCenterOrdinals = messageCenterOrdinals
        }
        draftState.containsLatestMessageMap = containsLatestMessageMap
        // only if different
        if (!draftState.messageOrdinals.equals(messageOrdinals)) {
          draftState.messageOrdinals = messageOrdinals
        }
        draftState.pendingOutboxToOrdinal = pendingOutboxToOrdinal
        return
      }
      case Chat2Gen.jumpToRecent:
        draftState.messageCenterOrdinals = draftState.messageCenterOrdinals.delete(
          action.payload.conversationIDKey
        )
        return
      case Chat2Gen.setContainsLastMessage: {
        const containsLatestMessageMap = draftState.containsLatestMessageMap
        containsLatestMessageMap.set(action.payload.conversationIDKey, action.payload.contains)
        draftState.containsLatestMessageMap = containsLatestMessageMap
        return
      }
      case Chat2Gen.messageRetry: {
        const {conversationIDKey, outboxID} = action.payload
        const ordinal = draftState.pendingOutboxToOrdinal.getIn([conversationIDKey, outboxID])
        if (!ordinal) {
          return
        }
        draftState.messageMap = draftState.messageMap.updateIn([conversationIDKey, ordinal], message => {
          if (message) {
            if (message.type === 'text') {
              return message.set('errorReason', null).set('submitState', 'pending')
            }
            if (message.type === 'attachment') {
              return message.set('errorReason', null).set('submitState', 'pending')
            }
          }
          return message
        })
        return
      }
      case Chat2Gen.messageErrored: {
        const {conversationIDKey, outboxID, reason} = action.payload
        const ordinal = draftState.pendingOutboxToOrdinal.getIn([conversationIDKey, outboxID])
        if (!ordinal) {
          return
        }
        draftState.messageMap = draftState.messageMap.updateIn([conversationIDKey, ordinal], message => {
          if (message) {
            if (message.type === 'text') {
              return message.set('errorReason', reason).set('submitState', 'failed')
            }
            if (message.type === 'attachment') {
              return message.set('errorReason', reason).set('submitState', 'failed')
            }
          }
          return message
        })
        return
      }
      case EngineGen.chat1ChatUiChatInboxLayout: {
        try {
          const layout: RPCChatTypes.UIInboxLayout = JSON.parse(action.payload.params.layout)
          if (!draftState.inboxHasLoaded) {
            // on first layout, initialize any drafts and muted status
            // After the first layout, any other updates will come in the form of meta updates.
            const draftMap = new Map(draftState.draftMap)
            const mutedMap = new Map(draftState.mutedMap)
            ;(layout.smallTeams || []).forEach((t: RPCChatTypes.UIInboxSmallTeamRow) => {
              mutedMap.set(t.convID, t.isMuted)
              if (t.draft) {
                draftMap.set(t.convID, t.draft)
              }
            })
            ;(layout.bigTeams || []).forEach((t: RPCChatTypes.UIInboxBigTeamRow) => {
              if (t.state === RPCChatTypes.UIInboxBigTeamRowTyp.channel) {
                mutedMap.set(t.channel.convID, t.channel.isMuted)
                if (t.channel.draft) {
                  draftMap.set(t.channel.convID, t.channel.draft)
                }
              }
            })
            draftState.draftMap = draftMap
            draftState.mutedMap = mutedMap
          }
          draftState.inboxLayout = layout
          draftState.inboxHasLoaded = true
        } catch (e) {
          logger.info('failed to JSON parse inbox layout: ' + e)
        }
        return
      }
      case EngineGen.chat1ChatUiChatBotCommandsUpdateStatus: {
        const botCommandsUpdateStatusMap = new Map(draftState.botCommandsUpdateStatusMap)
        botCommandsUpdateStatusMap.set(
          Types.stringToConversationIDKey(action.payload.params.convID),
          action.payload.params.status
        )
        draftState.botCommandsUpdateStatusMap = botCommandsUpdateStatusMap
        return
      }
      case EngineGen.chat1NotifyChatChatTypingUpdate: {
        const {typingUpdates} = action.payload.params
        const typingMap = new Map(
          (typingUpdates || []).reduce<Array<[string, Set<string>]>>((arr, u) => {
            arr.push([Types.conversationIDToKey(u.convID), new Set((u.typers || []).map(t => t.username))])
            return arr
          }, [])
        )
        draftState.typingMap = typingMap
        return
      }
      case Chat2Gen.toggleLocalReaction: {
        const {conversationIDKey, emoji, targetOrdinal, username} = action.payload
        draftState.messageMap = draftState.messageMap.update(
          conversationIDKey,
          I.Map(),
          (map: I.Map<Types.Ordinal, Types.Message>) => {
            return map.update(targetOrdinal, message => {
              if (!Constants.isDecoratedMessage(message)) {
                return message
              }
              const reactions = message.reactions
              // @ts-ignore thinks `message` is the inner type
              return message.set(
                'reactions',
                reactions.withMutations(reactionMap => {
                  reactionMap.update(emoji, I.Set(), rs => {
                    const existing = rs.find(r => r.username === username)
                    if (existing) {
                      // found an existing reaction. remove it from our list
                      return rs.delete(existing)
                    }
                    // no existing reaction. add this one to the map
                    return rs.add(Constants.makeReaction({timestamp: Date.now(), username}))
                  })
                  const newSet = reactionMap.get(emoji)
                  if (newSet && newSet.size === 0) {
                    reactionMap.delete(emoji)
                  }
                })
              )
            })
          }
        )
        return
      }
      case Chat2Gen.updateReactions: {
        const {conversationIDKey, updates} = action.payload
        const targetData = updates.map(u => ({
          reactions: u.reactions,
          targetMsgID: u.targetMsgID,
          targetOrdinal: messageIDToOrdinal(
            draftState.messageMap,
            draftState.pendingOutboxToOrdinal,
            conversationIDKey,
            u.targetMsgID
          ),
        }))
        draftState.messageMap = draftState.messageMap.update(
          conversationIDKey,
          I.Map(),
          (map: I.Map<Types.Ordinal, Types.Message>) =>
            map.withMutations(mm => {
              targetData.forEach(td => {
                if (!td.targetOrdinal) {
                  logger.info(
                    `updateReactions: couldn't find target ordinal for targetMsgID=${
                      td.targetMsgID
                    } in convID=${conversationIDKey}`
                  )
                  return
                }
                mm.update(td.targetOrdinal, message => {
                  if (!message || message.type === 'deleted' || message.type === 'placeholder') {
                    return message
                  }
                  // @ts-ignore thinks `message` is the inner type
                  return message.set('reactions', td.reactions)
                })
              })
            })
        )
        return
      }
      case Chat2Gen.messagesWereDeleted: {
        const {
          conversationIDKey,
          deletableMessageTypes = Constants.allMessageTypes,
          messageIDs = [],
          ordinals = [],
          upToMessageID = null,
        } = action.payload

        const upToOrdinals: Array<Types.Ordinal> = []
        if (upToMessageID) {
          const ordinalToMessage = draftState.messageMap.get(conversationIDKey) || new Map()
          ;[...ordinalToMessage.entries()].reduce((arr, [ordinal, m]) => {
            if (m.id < upToMessageID && deletableMessageTypes.has(m.type)) {
              arr.push(ordinal)
            }
            return arr
          }, upToOrdinals)
        }

        const allOrdinals = I.Set(
          [
            ...ordinals,
            ...messageIDs.map(messageID =>
              messageIDToOrdinal(
                draftState.messageMap,
                draftState.pendingOutboxToOrdinal,
                conversationIDKey,
                messageID
              )
            ),
            ...upToOrdinals,
          ].reduce<Array<Types.Ordinal>>((arr, n) => {
            if (n) {
              arr.push(n)
            }
            return arr
          }, [])
        )

        const messageMap = new Map(draftState.messageMap)
        const ordToMsg = new Map(messageMap.get(conversationIDKey) || [])
        allOrdinals.forEach(ordinal => {
          const old = ordToMsg.get(ordinal)
          if (old) {
            ordToMsg.set(
              ordinal,
              Constants.makeMessageDeleted({
                author: old.author,
                conversationIDKey: old.conversationIDKey,
                id: old.id,
                ordinal: old.ordinal,
                timestamp: old.timestamp,
              })
            )
          }
        })
        draftState.messageMap = messageMap

        const messageOrdinals = new Map(draftState.messageOrdinals)
        const ords = new Set(messageOrdinals.get(conversationIDKey) || [])
        allOrdinals.forEach(o => ords.delete(o))
        messageOrdinals.set(conversationIDKey, ords)
        draftState.messageOrdinals = messageOrdinals
        return
      }
      case Chat2Gen.updateMoreToLoad: {
        const moreToLoadMap = new Map(draftState.moreToLoadMap)
        moreToLoadMap.set(action.payload.conversationIDKey, action.payload.moreToLoad)
        draftState.moreToLoadMap = moreToLoadMap
        return
      }
      case Chat2Gen.updateConvExplodingModes: {
        const {modes} = action.payload
        const explodingModes = new Map()
        modes.forEach(mode =>
          explodingModes.set(Types.conversationIDKeyToString(mode.conversationIDKey), mode.seconds)
        )
        draftState.explodingModes = explodingModes
        return
      }
      case Chat2Gen.setExplodingModeLock: {
        const {conversationIDKey, unset} = action.payload
        const mode = draftState.explodingModes.get(conversationIDKey) || 0
        // we already have the new mode in `explodingModes`, if we've already locked it we shouldn't update
        const alreadyLocked = (draftState.explodingModeLocks.get(conversationIDKey) || null) !== null
        if (unset) {
          const explodingModeLocks = new Map(draftState.explodingModeLocks)
          explodingModeLocks.delete(conversationIDKey)
          draftState.explodingModeLocks = explodingModeLocks
          return
        }
        if (!alreadyLocked) {
          const explodingModeLocks = new Map(draftState.explodingModeLocks)
          explodingModeLocks.set(conversationIDKey, mode)
          draftState.explodingModeLocks = explodingModeLocks
        }
        return
      }
      case Chat2Gen.giphySend: {
        const giphyWindowMap = new Map(draftState.giphyWindowMap)
        giphyWindowMap.set(action.payload.conversationIDKey, false)
        draftState.giphyWindowMap = giphyWindowMap
        const unsentTextMap = new Map(draftState.unsentTextMap)
        unsentTextMap.set(action.payload.conversationIDKey, new HiddenString(''))
        draftState.unsentTextMap = unsentTextMap
        return
      }
      case Chat2Gen.toggleGiphyPrefill: {
        // if the window is up, just blow it away
        const unsentTextMap = new Map(draftState.unsentTextMap)
        if (draftState.giphyWindowMap.get(action.payload.conversationIDKey)) {
          unsentTextMap.set(action.payload.conversationIDKey, new HiddenString(''))
        } else {
          unsentTextMap.set(action.payload.conversationIDKey, new HiddenString('/giphy '))
        }
        draftState.unsentTextMap = unsentTextMap
        return
      }
      case Chat2Gen.setUnsentText: {
        const unsentTextMap = new Map(draftState.unsentTextMap)
        unsentTextMap.set(action.payload.conversationIDKey, action.payload.text)
        draftState.unsentTextMap = unsentTextMap
        return
      }
      case Chat2Gen.setPrependText: {
        const prependTextMap = new Map(draftState.prependTextMap)
        prependTextMap.set(action.payload.conversationIDKey, action.payload.text)
        draftState.prependTextMap = prependTextMap
        return
      }
      case Chat2Gen.toggleReplyToMessage: {
        const {conversationIDKey, ordinal} = action.payload
        if (ordinal) {
          const replyToMap = new Map(draftState.replyToMap)
          replyToMap.set(conversationIDKey, ordinal)
          draftState.replyToMap = replyToMap
          // we always put something in prepend to trigger the focus regain on the input bar
          const prependTextMap = new Map(draftState.prependTextMap)
          prependTextMap.set(conversationIDKey, new HiddenString(''))
          draftState.prependTextMap = prependTextMap
          return
        } else {
          const replyToMap = new Map(draftState.replyToMap)
          replyToMap.delete(conversationIDKey)
          draftState.replyToMap = replyToMap
          return
        }
      }
      case Chat2Gen.replyJump: {
        const messageCenterOrdinals = new Map(draftState.messageCenterOrdinals)
        messageCenterOrdinals.delete(action.payload.conversationIDKey)
        draftState.messageCenterOrdinals = messageCenterOrdinals
        return
      }
      case Chat2Gen.threadSearchResults: {
        const threadSearchInfoMap = new Map(draftState.threadSearchInfoMap)
        const info =
          threadSearchInfoMap.get(action.payload.conversationIDKey) || Constants.makeThreadSearchInfo()

        if (action.payload.clear) {
          info.hits = action.payload.messages
        } else {
          info.hits = [...info.hits, ...action.payload.messages]
        }
        threadSearchInfoMap.set(action.payload.conversationIDKey, info)
        draftState.threadSearchInfoMap = threadSearchInfoMap
        return
      }
      case Chat2Gen.setThreadSearchStatus: {
        const threadSearchInfoMap = new Map(draftState.threadSearchInfoMap)
        const info =
          threadSearchInfoMap.get(action.payload.conversationIDKey) || Constants.makeThreadSearchInfo()
        info.status = action.payload.status
        threadSearchInfoMap.set(action.payload.conversationIDKey, info)
        draftState.threadSearchInfoMap = threadSearchInfoMap
        return
      }
      case Chat2Gen.toggleThreadSearch: {
        const threadSearchInfoMap = new Map(draftState.threadSearchInfoMap)
        const info =
          threadSearchInfoMap.get(action.payload.conversationIDKey) || Constants.makeThreadSearchInfo()
        info.hits = []
        info.status = 'initial'
        info.visible = !info.visible
        threadSearchInfoMap.set(action.payload.conversationIDKey, info)
        draftState.threadSearchInfoMap = threadSearchInfoMap

        const messageCenterOrdinals = new Map(draftState.messageCenterOrdinals)
        messageCenterOrdinals.delete(action.payload.conversationIDKey)
        draftState.messageCenterOrdinals = messageCenterOrdinals
        return
      }
      case Chat2Gen.threadSearch: {
        const threadSearchInfoMap = new Map(draftState.threadSearchInfoMap)
        const info =
          threadSearchInfoMap.get(action.payload.conversationIDKey) || Constants.makeThreadSearchInfo()
        info.hits = []
        threadSearchInfoMap.set(action.payload.conversationIDKey, info)
        draftState.threadSearchInfoMap = threadSearchInfoMap
        return
      }
      case Chat2Gen.setThreadSearchQuery: {
        const threadSearchQueryMap = new Map(draftState.threadSearchQueryMap)
        threadSearchQueryMap.set(action.payload.conversationIDKey, action.payload.query)
        draftState.threadSearchQueryMap = threadSearchQueryMap
        return
      }
      case Chat2Gen.inboxSearchSetTextStatus:
        draftState.inboxSearch = {
          ...(draftState.inboxSearch || Constants.makeInboxSearchInfo()),
          textStatus: action.payload.status,
        }
        return
      case Chat2Gen.inboxSearchSetIndexPercent: {
        if (!draftState.inboxSearch || draftState.inboxSearch.textStatus !== 'inprogress') {
          return
        }
        const {percent} = action.payload
        draftState.inboxSearch.indexPercent = percent
        return
      }
      case Chat2Gen.toggleInboxSearch: {
        const {enabled} = action.payload
        if (enabled && !draftState.inboxSearch) {
          draftState.inboxSearch = Constants.makeInboxSearchInfo()
        } else if (!enabled && draftState.inboxSearch) {
          draftState.inboxSearch = undefined
        }
        return
      }
      case Chat2Gen.inboxSearchTextResult: {
        if (!draftState.inboxSearch || draftState.inboxSearch.textStatus !== 'inprogress') {
          return
        }
        const {result} = action.payload
        const {conversationIDKey} = result
        const old = draftState.inboxSearch || Constants.makeInboxSearchInfo()
        const textResults = old.textResults.filter(r => r.conversationIDKey !== conversationIDKey)
        textResults.push(result)
        draftState.inboxSearch.textResults = textResults.sort((l, r) => r.time - l.time)
        return
      }
      case Chat2Gen.inboxSearchStarted:
        if (!draftState.inboxSearch) {
          return
        }
        draftState.inboxSearch = {
          ...(draftState.inboxSearch || Constants.makeInboxSearchInfo()),
          nameStatus: 'inprogress',
          selectedIndex: 0,
          textResults: [],
          textStatus: 'inprogress',
        }
        return
      case Chat2Gen.inboxSearchNameResults: {
        if (!draftState.inboxSearch || draftState.inboxSearch.nameStatus !== 'inprogress') {
          return
        }
        const {results, unread} = action.payload
        draftState.inboxSearch.nameResults = results
        draftState.inboxSearch.nameResultsUnread = unread
        draftState.inboxSearch.nameStatus = 'success'
        return
      }
      case Chat2Gen.inboxSearchMoveSelectedIndex: {
        if (!draftState.inboxSearch) {
          return
        }
        let selectedIndex = draftState.inboxSearch.selectedIndex
        const totalResults =
          draftState.inboxSearch.nameResults.length + draftState.inboxSearch.textResults.length
        if (action.payload.increment && selectedIndex < totalResults - 1) {
          selectedIndex++
        } else if (!action.payload.increment && selectedIndex > 0) {
          selectedIndex--
        }

        draftState.inboxSearch.selectedIndex = selectedIndex
        return
      }
      case Chat2Gen.inboxSearchSelect: {
        const {selectedIndex} = action.payload
        if (!draftState.inboxSearch || selectedIndex == null) {
          return
        }
        draftState.inboxSearch.selectedIndex = selectedIndex
        return
      }
      case Chat2Gen.inboxSearch: {
        if (!draftState.inboxSearch) {
          return
        }

        const {query} = action.payload
        draftState.inboxSearch.query = query
        return
      }
      case Chat2Gen.loadAttachmentView: {
        const {conversationIDKey, viewType} = action.payload
        const attachmentViewMap = new Map(draftState.attachmentViewMap)
        const viewMap = new Map(attachmentViewMap.get(conversationIDKey) || [])
        viewMap.set(viewType, {
          ...(viewMap.get(viewType) || Constants.initialAttachmentViewInfo),
          status: 'loading',
        })
        attachmentViewMap.set(conversationIDKey, viewMap)
        draftState.attachmentViewMap = attachmentViewMap
        return
      }
      case Chat2Gen.addAttachmentViewMessage: {
        const {conversationIDKey, viewType} = action.payload
        const attachmentViewMap = new Map(draftState.attachmentViewMap)
        const viewMap = new Map(attachmentViewMap.get(conversationIDKey) || [])
        const old = viewMap.get(viewType) || Constants.initialAttachmentViewInfo
        viewMap.set(viewType, {
          ...old,
          messages:
            old.messages.findIndex((item: any) => item.id === action.payload.message.id) < 0
              ? old.messages.concat(action.payload.message).sort((l: any, r: any) => r.id - l.id)
              : old.messages,
        })
        attachmentViewMap.set(conversationIDKey, viewMap)
        draftState.attachmentViewMap = attachmentViewMap
        return
      }
      case Chat2Gen.setAttachmentViewStatus: {
        const {conversationIDKey, viewType, last, status} = action.payload
        const attachmentViewMap = new Map(draftState.attachmentViewMap)
        const viewMap = new Map(attachmentViewMap.get(conversationIDKey) || [])
        viewMap.set(viewType, {
          ...(viewMap.get(viewType) || Constants.initialAttachmentViewInfo),
          last: !!last,
          status,
        })
        attachmentViewMap.set(conversationIDKey, viewMap)
        draftState.attachmentViewMap = attachmentViewMap
        return
      }
      case Chat2Gen.clearAttachmentView: {
        const {conversationIDKey} = action.payload
        const attachmentViewMap = new Map(draftState.attachmentViewMap)
        attachmentViewMap.delete(conversationIDKey)
        draftState.attachmentViewMap = attachmentViewMap
        return
      }
      case Chat2Gen.staticConfigLoaded:
        draftState.staticConfig = action.payload.staticConfig
        return
      case Chat2Gen.metasReceived: {
        draftState.inboxHasLoaded = action.payload.fromInboxRefresh ? true : draftState.inboxHasLoaded
        const draftMap = new Map(draftState.draftMap)
        const mutedMap = new Map(draftState.mutedMap)
        action.payload.metas.forEach((m: Types.ConversationMeta) => {
          draftMap.set(m.conversationIDKey, m.draft)
          mutedMap.set(m.conversationIDKey, m.isMuted)
        })
        draftState.draftMap = draftMap
        draftState.mutedMap = mutedMap
        draftState.messageMap = messageMapReducer(
          draftState.messageMap,
          action,
          draftState.pendingOutboxToOrdinal
        )
        draftState.messageOrdinals = messageOrdinalsReducer(draftState.messageOrdinals, action)
        draftState.metaMap = metaMapReducer(draftState.metaMap, action)
        draftState.trustedInboxHasLoaded = action.payload.initialTrustedLoad
          ? true
          : draftState.trustedInboxHasLoaded
        return
      }
      case Chat2Gen.paymentInfoReceived: {
        const {conversationIDKey, messageID, paymentInfo} = action.payload

        const accountsInfoMap = new Map(draftState.accountsInfoMap)
        const convMap = new Map(accountsInfoMap.get(conversationIDKey) || [])
        convMap.set(messageID, paymentInfo)
        accountsInfoMap.set(conversationIDKey, convMap)
        draftState.accountsInfoMap = accountsInfoMap

        const paymentStatusMap = new Map(draftState.paymentStatusMap)
        paymentStatusMap.set(paymentInfo.paymentID, paymentInfo)
        draftState.paymentStatusMap = paymentStatusMap
        return
      }
      case Chat2Gen.setMaybeMentionInfo: {
        const {name, info} = action.payload
        const maybeMentionMap = new Map(draftState.maybeMentionMap)
        maybeMentionMap.set(name, info)
        draftState.maybeMentionMap = maybeMentionMap
        return
      }
      case Chat2Gen.requestInfoReceived: {
        const {conversationIDKey, messageID, requestInfo} = action.payload

        const accountsInfoMap = new Map(draftState.accountsInfoMap)
        const convMap = new Map(accountsInfoMap.get(conversationIDKey) || [])
        convMap.set(messageID, requestInfo)
        accountsInfoMap.set(conversationIDKey, convMap)
        draftState.accountsInfoMap = accountsInfoMap
        return
      }
      case Chat2Gen.attachmentFullscreenSelection: {
        const {autoPlay, message} = action.payload
        draftState.attachmentFullscreenSelection = {autoPlay, message}
        return
      }
      case Chat2Gen.handleSeeingWallets: // fallthrough
      case Chat2Gen.setWalletsOld:
        if (draftState.isWalletsNew) {
          draftState.isWalletsNew = false
        }
        return
      case Chat2Gen.attachmentLoading: {
        const {message} = action.payload
        if (
          draftState.attachmentFullscreenSelection &&
          draftState.attachmentFullscreenSelection.message.conversationIDKey === message.conversationIDKey &&
          draftState.attachmentFullscreenSelection.message.id === message.id &&
          message.type === 'attachment'
        ) {
          draftState.attachmentFullscreenSelection = {
            autoPlay: draftState.attachmentFullscreenSelection.autoPlay,
            message: {...message, transferState: 'downloading', transferProgress: action.payload.ratio},
          }
        }

        const {conversationIDKey} = action.payload
        const viewType = RPCChatTypes.GalleryItemTyp.doc
        const attachmentViewMap = new Map(draftState.attachmentViewMap)
        const viewMap = new Map(attachmentViewMap.get(conversationIDKey) || [])
        const old = viewMap.get(viewType) || Constants.initialAttachmentViewInfo
        const messages = old.messages
        const idx = old.messages.findIndex(item => item.id === message.id)
        if (idx !== -1) {
          const m: Types.MessageAttachment = messages[idx] as any // TODO don't cast
          old.messages[idx] = {...m, transferState: 'downloading', transferProgress: action.payload.ratio}
        }
        viewMap.set(viewType, {...old, messages})
        attachmentViewMap.set(conversationIDKey, viewMap)
        draftState.attachmentViewMap = attachmentViewMap

        draftState.metaMap = metaMapReducer(draftState.metaMap, action)
        draftState.messageMap = messageMapReducer(
          draftState.messageMap,
          action,
          draftState.pendingOutboxToOrdinal
        )
        draftState.messageOrdinals = messageOrdinalsReducer(draftState.messageOrdinals, action)
        return
      }
      case Chat2Gen.attachmentDownloaded: {
        const {message, path} = action.payload
        const {conversationIDKey} = message
        if (
          !action.payload.error &&
          draftState.attachmentFullscreenSelection &&
          draftState.attachmentFullscreenSelection.message.conversationIDKey === message.conversationIDKey &&
          draftState.attachmentFullscreenSelection.message.id === message.id &&
          message.type === 'attachment'
        ) {
          draftState.attachmentFullscreenSelection.message = {
            ...message,
            downloadPath: path,
          }
        }

        const attachmentViewMap = new Map(draftState.attachmentViewMap)
        const viewMap = new Map(attachmentViewMap.get(conversationIDKey) || [])
        const viewType = RPCChatTypes.GalleryItemTyp.doc
        const old = viewMap.get(viewType) || Constants.initialAttachmentViewInfo
        const messages = old.messages
        const idx = old.messages.findIndex(item => item.id === message.id)
        if (idx !== -1) {
          const m: Types.MessageAttachment = messages[idx] as any // TODO don't cast
          old.messages[idx] = {
            ...m,
            downloadPath: path,
            fileURLCached: true,
            transferProgress: 0,
            transferState: undefined,
          }
        }
        viewMap.set(viewType, {...old, messages})
        attachmentViewMap.set(conversationIDKey, viewMap)
        draftState.attachmentViewMap = attachmentViewMap

        draftState.metaMap = metaMapReducer(draftState.metaMap, action)
        draftState.messageMap = messageMapReducer(
          draftState.messageMap,
          action,
          draftState.pendingOutboxToOrdinal
        )
        draftState.messageOrdinals = messageOrdinalsReducer(draftState.messageOrdinals, action)
        return
      }
      case Chat2Gen.updateUserReacjis: {
        let {skinTone, topReacjis} = action.payload.userReacjis
        if (!topReacjis) {
          topReacjis = Constants.defaultTopReacjis
        }
        draftState.userReacjis = {skinTone, topReacjis}
        return
      }
      case Chat2Gen.dismissBottomBanner: {
        const dismissedInviteBannersMap = new Map(draftState.dismissedInviteBannersMap)
        dismissedInviteBannersMap.set(action.payload.conversationIDKey, true)
        draftState.dismissedInviteBannersMap = dismissedInviteBannersMap
        return
      }
      // metaMap/messageMap/messageOrdinalsList only actions
      case Chat2Gen.messageDelete:
      case Chat2Gen.messageEdit:
      case Chat2Gen.messageWasEdited:
      case Chat2Gen.pendingMessageWasEdited:
      case Chat2Gen.messageAttachmentUploaded:
      case Chat2Gen.metaReceivedError:
      case Chat2Gen.metaRequestingTrusted:
      case Chat2Gen.attachmentUploading:
      case Chat2Gen.attachmentUploaded:
      case Chat2Gen.attachmentMobileSave:
      case Chat2Gen.attachmentMobileSaved:
      case Chat2Gen.attachmentDownload:
      case Chat2Gen.markConversationsStale:
      case Chat2Gen.notificationSettingsUpdated:
      case Chat2Gen.metaDelete:
      case Chat2Gen.setConversationOffline:
      case Chat2Gen.updateConvRetentionPolicy:
      case Chat2Gen.updateTeamRetentionPolicy:
      case Chat2Gen.messagesExploded:
      case Chat2Gen.saveMinWriterRole:
      case Chat2Gen.updateMessages:
      case Chat2Gen.clearMessages:
      case Chat2Gen.clearMetas:
        draftState.metaMap = metaMapReducer(draftState.metaMap, action)
        draftState.messageMap = messageMapReducer(
          draftState.messageMap,
          action,
          draftState.pendingOutboxToOrdinal
        )
        draftState.messageOrdinals = messageOrdinalsReducer(draftState.messageOrdinals, action)
        return
      case TeamBuildingGen.resetStore:
      case TeamBuildingGen.cancelTeamBuilding:
      case TeamBuildingGen.addUsersToTeamSoFar:
      case TeamBuildingGen.removeUsersFromTeamSoFar:
      case TeamBuildingGen.searchResultsLoaded:
      case TeamBuildingGen.finishedTeamBuilding:
      case TeamBuildingGen.fetchedUserRecs:
      case TeamBuildingGen.fetchUserRecs:
      case TeamBuildingGen.search:
      case TeamBuildingGen.selectRole:
      case TeamBuildingGen.labelsSeen:
      case TeamBuildingGen.changeSendNotification:
        draftState.teamBuilding = teamBuildingReducer('chat2', _state.teamBuilding, action)
        return
      // Saga only actions
      case Chat2Gen.attachmentPreviewSelect:
      case Chat2Gen.attachmentsUpload:
      case Chat2Gen.attachmentPasted:
      case Chat2Gen.attachmentFullscreenNext:
      case Chat2Gen.desktopNotification:
      case Chat2Gen.inboxRefresh:
      case Chat2Gen.joinConversation:
      case Chat2Gen.leaveConversation:
      case Chat2Gen.loadOlderMessagesDueToScroll:
      case Chat2Gen.loadNewerMessagesDueToScroll:
      case Chat2Gen.markInitiallyLoadedThreadAsRead:
      case Chat2Gen.messageDeleteHistory:
      case Chat2Gen.messageReplyPrivately:
      case Chat2Gen.metaHandleQueue:
      case Chat2Gen.metaNeedsUpdating:
      case Chat2Gen.metaRequestTrusted:
      case Chat2Gen.muteConversation:
      case Chat2Gen.openFolder:
      case Chat2Gen.resetChatWithoutThem:
      case Chat2Gen.resetLetThemIn:
      case Chat2Gen.sendTyping:
      case Chat2Gen.setConvRetentionPolicy:
      case Chat2Gen.navigateToInbox:
      case Chat2Gen.navigateToThread:
      case Chat2Gen.messageAttachmentNativeShare:
      case Chat2Gen.messageAttachmentNativeSave:
      case Chat2Gen.updateNotificationSettings:
      case Chat2Gen.blockConversation:
      case Chat2Gen.hideConversation:
      case Chat2Gen.unhideConversation:
      case Chat2Gen.previewConversation:
      case Chat2Gen.setConvExplodingMode:
      case Chat2Gen.toggleMessageReaction:
      case Chat2Gen.setMinWriterRole:
      case Chat2Gen.openChatFromWidget:
      case Chat2Gen.prepareFulfillRequestForm:
      case Chat2Gen.unfurlResolvePrompt:
      case Chat2Gen.unfurlRemove:
      case Chat2Gen.unsentTextChanged:
      case Chat2Gen.confirmScreenResponse:
      case Chat2Gen.toggleMessageCollapse:
      case Chat2Gen.toggleInfoPanel:
      case Chat2Gen.addUsersToChannel:
      case Chat2Gen.deselectConversation:
      case Chat2Gen.createConversation:
      case Chat2Gen.loadMessagesCentered:
      case Chat2Gen.tabSelected:
      case Chat2Gen.resolveMaybeMention:
      case Chat2Gen.pinMessage:
      case Chat2Gen.unpinMessage:
      case Chat2Gen.ignorePinnedMessage:
        return
    }
  })
