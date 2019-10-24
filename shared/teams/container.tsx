import * as React from 'react'
import * as Container from '../util/container'
import * as Kb from '../common-adapters'
import * as I from 'immutable'
import * as FsConstants from '../constants/fs'
import * as FsTypes from '../constants/types/fs'
import * as GregorGen from '../actions/gregor-gen'
import * as TeamsGen from '../actions/teams-gen'
import Teams, {Props} from './main'
import {HeaderRightActions} from './main/header'
import openURL from '../util/open-url'
import * as Constants from '../constants/teams'
import * as WaitingConstants from '../constants/waiting'
import * as Types from '../constants/types/teams'
import {memoize} from '../util/memoize'

type OwnProps = Container.PropsWithSafeNavigation<{}>

// share some between headerRightActions on desktop and component on mobile
const headerActions = (dispatch: Container.TypedDispatch, ownProps: OwnProps) => ({
  onCreateTeam: () => {
    dispatch(
      ownProps.safeNavigateAppendPayload({
        path: [{props: {}, selected: 'teamNewTeamDialog'}],
      })
    )
  },
  onJoinTeam: () => {
    dispatch(ownProps.safeNavigateAppendPayload({path: ['teamJoinTeamDialog']}))
  },
})

const orderTeams = memoize((teams: Types.State['teamDetails']) =>
  [...teams.values()].sort((a, b) => a.teamname.localeCompare(b.teamname))
)

class Reloadable extends React.PureComponent<Props & {loadTeams: () => void; onClearBadges: () => void}> {
  static navigationOptions = {
    header: undefined,
    headerRightActions: () => <ConnectedHeaderRightActions />,
    title: 'Teams',
  }

  private onWillBlur = () => {
    this.props.onClearBadges()
  }
  private onDidFocus = () => {
    this.props.loadTeams()
  }
  componentWillUnmount() {
    this.onWillBlur()
  }
  componentDidMount() {
    this.onDidFocus()
  }
  render() {
    const {loadTeams, ...rest} = this.props
    return (
      <Kb.Reloadable waitingKeys={Constants.teamsLoadedWaitingKey} onReload={loadTeams} reloadOnMount={true}>
        {Container.isMobile && (
          <Kb.NavigationEvents onDidFocus={this.onDidFocus} onWillBlur={this.onWillBlur} />
        )}
        <Teams {...rest} />
      </Kb.Reloadable>
    )
  }
}

const _Connected = Container.connect(
  (state: Container.TypedState) => ({
    _deletedTeams: state.teams.deletedTeams,
    _newTeams: state.teams.newTeams,
    _teamresetusers: state.teams.teamNameToResetUsers || I.Map(),
    _teams: state.teams.teamDetails,
    loaded: !WaitingConstants.anyWaiting(state, Constants.teamsLoadedWaitingKey),
    newTeamRequests: state.teams.newTeamRequests,
    sawChatBanner: state.teams.sawChatBanner || false,
  }),
  (dispatch: Container.TypedDispatch, ownProps: OwnProps) => ({
    ...headerActions(dispatch, ownProps),
    loadTeams: () => dispatch(TeamsGen.createGetTeams()),
    onClearBadges: () => dispatch(TeamsGen.createClearNavBadges()),
    onHideChatBanner: () =>
      dispatch(GregorGen.createUpdateCategory({body: 'true', category: 'sawChatBanner'})),
    onManageChat: (teamname: Types.Teamname) =>
      dispatch(
        ownProps.safeNavigateAppendPayload({path: [{props: {teamname}, selected: 'chatManageChannels'}]})
      ),
    onOpenFolder: (teamname: Types.Teamname) =>
      dispatch(
        FsConstants.makeActionForOpenPathInFilesTab(FsTypes.stringToPath(`/keybase/team/${teamname}`))
      ),
    onReadMore: () => {
      openURL('https://keybase.io/blog/introducing-keybase-teams')
    },
    onViewTeam: (teamname: Types.Teamname) =>
      dispatch(ownProps.safeNavigateAppendPayload({path: [{props: {teamname}, selected: 'team'}]})),
  }),
  (stateProps, dispatchProps, _: OwnProps) => ({
    deletedTeams: stateProps._deletedTeams,
    loaded: stateProps.loaded,
    newTeams: stateProps._newTeams,
    newTeamRequests: stateProps.newTeamRequests,
    sawChatBanner: stateProps.sawChatBanner,
    teamresetusers: stateProps._teamresetusers.toObject(),
    teams: orderTeams(stateProps._teams),
    ...dispatchProps,
  })
)(Reloadable)
const Connected = Container.withSafeNavigation(_Connected)

const ConnectedHeaderRightActions = Container.compose(
  Container.withSafeNavigation,
  Container.connect(() => ({}), headerActions, (s, d, o) => ({...o, ...s, ...d}))
)(HeaderRightActions as any)

export default Connected
